// Host-side runtime for the prototype. It is deliberately a plain object graph
// with no imports from the Desktop installation: every capability is reached
// through the Cordis service objects that the Host already publishes.
//
// Isolation model:
// - a new Session is always created from workspaceId + explicit agentPreset;
// - its permission is set to workspace-write + ask before the first prompt;
// - approval listeners are registered on that Agent's scoped context only;
// - tool arguments are captured from the public `tools/execute` waterfall for
//   that Agent and are the authoritative operation shown to Codex.

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  SCHEMA,
  appendJsonl,
  atomicWriteJson,
  controlLayout,
  ensureLayout,
  listJson,
  moveInto,
  newId,
  nowIso,
  readJson,
} from './lib/store.mjs'
import {
  ACTIVE_TASK_STATUSES,
  REQUIRED_SERVICES,
  isOwnedApproval,
  mandatoryPermission,
  permissionBundleMatches,
  permissionFromEvents,
  selectPermissionPreset,
  validateCommandCwd,
} from './lib/policy.mjs'
import {
  beginFirstRound,
  beginRound,
  createTaskRecord,
  markApprovalResolved,
  markAwaiting,
  markCancelled,
  markCompleted,
  markFailed,
  markInterrupted,
  markRoundAccepted,
} from './lib/tasks.mjs'
import {
  assertCompleteToolCall,
  buildApprovalRecord,
  closeStaleApprovals,
  resolveApprovalFile,
  waitForDecision,
  writeApprovalRequest,
} from './lib/approval-queue.mjs'
import { validateCommand } from './lib/commands.mjs'

const PLUGIN_VERSION = '0.2.1'

class TaskStore {
  constructor(controlDir) {
    this.layout = controlLayout(controlDir)
    this.chains = new Map()
  }

  file(taskId) {
    return path.join(this.layout.tasks, `${taskId}.json`)
  }

  async read(taskId) {
    return await readJson(this.file(taskId))
  }

  async create(task) {
    await atomicWriteJson(this.file(task.taskId), task, { exclusive: true })
    return task
  }

  async write(task) {
    task.updatedAt = nowIso()
    await atomicWriteJson(this.file(task.taskId), task)
    return task
  }

  async update(taskId, mutate) {
    const previous = this.chains.get(taskId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const task = await this.read(taskId)
      if (!task) throw new Error(`task ${taskId} does not exist`)
      const result = await mutate(task)
      await this.write(task)
      return result === undefined ? task : result
    })
    this.chains.set(taskId, next.then(() => undefined, () => undefined))
    return await next
  }

  async list() {
    const items = await listJson(this.layout.tasks)
    return items.map((item) => item.value).filter((task) => task && typeof task.taskId === 'string')
  }
}

export class DelegationRuntime {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.layout = controlLayout(config.controlDir)
    this.tasks = new TaskStore(config.controlDir)
    this.hostId = newId('host')
    this.startedAt = nowIso()
    this.stopping = false
    this.started = false
    this.pumping = false
    this.sessionIndex = new Map()
    this.taskChains = new Map()
    this.activeCommands = new Set()
    this.roundAborts = new Map()
    this.toolExecutions = new Map()
    this.approvalAttached = new WeakSet()
    this.permissionGuarded = new WeakSet()
    this.hostListenersInstalled = false
    this.hostListenerDisposers = []
    this.agentListenerDisposers = new WeakMap()
    this.ownedAgents = new Set()
    this.roundRuns = new Set()
    this.shutdownPromise = null
    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve
    })
  }

  async start() {
    if (this.started) return
    this.started = true
    await ensureLayout(this.config.controlDir)
    this.installHostListeners()
    await this.writeHost('starting')
    await this.recover()
    this.heartbeatTimer = setInterval(() => {
      this.writeHost('ready').catch((error) => this.log('warn', `heartbeat failed: ${error}`))
    }, this.config.heartbeatMs)
    this.heartbeatTimer.unref?.()
    this.commandTimer = setInterval(() => {
      this.pump().catch((error) => this.log('warn', `command pump failed: ${error}`))
    }, this.config.pollIntervalMs)
    this.commandTimer.unref?.()
    await this.writeHost('ready')
    await this.pump()
    this.log('info', `ready: control=${this.config.controlDir} allowedRoot=${this.config.allowedRoot}`)
  }

  async recover() {
    const closed = await closeStaleApprovals({ controlDir: this.config.controlDir, hostId: this.hostId })
    const tasks = await this.tasks.list()
    for (const task of tasks) {
      if (ACTIVE_TASK_STATUSES.includes(task.status)) {
        await this.tasks.update(task.taskId, (current) => {
          markInterrupted(current, {
            reason: 'Host plugin restarted or was not running while this task was active; approval waiters were lost',
          })
        })
        await this.appendEvent(task.taskId, 'task-interrupted', {
          hostId: this.hostId,
          reason: 'startup recovery',
        })
      }
      if (task.session?.id) {
        this.sessionIndex.set(task.session.id, task.taskId)
        const agent = this.ctx.agents.get(task.session.id)
        if (agent) {
          await this.ensureOwnedAgentHooks(task, agent, { phase: 'recover', throwOnPermission: false }).catch((error) => {
            this.log('warn', `recover could not attach hooks to ${task.session.id}: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
      }
    }
    if (closed.length > 0) {
      this.log('warn', `closed ${closed.length} stale approval request(s) at startup`)
    }
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    this.stopping = true
    this.shutdownPromise = this.finishShutdown()
    return this.shutdownPromise
  }

  async finishShutdown() {
    this.resolveStop?.()
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.commandTimer) clearInterval(this.commandTimer)
    for (const abort of this.roundAborts.values()) {
      try {
        abort.abort(new Error('Host plugin stopping'))
      } catch {
        // already aborted
      }
    }
    const tasks = await this.tasks.list().catch(() => [])
    const agents = new Set(this.ownedAgents)
    for (const task of tasks) {
      if (task.session?.id) {
        const agent = this.ctx.agents.get(task.session.id)
        if (agent) agents.add(agent)
      }
    }
    // Stopping must actually stop model work, not just rewrite a file. This is
    // the plugin's own Session, so a user-cause cancel without keepInbox is the
    // public Agent capability to use.
    for (const agent of agents) {
      try {
        agent.cancel({ kind: 'user' })
      } catch (error) {
        this.log('warn', `Agent.cancel(${agent?.id}) during shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const task of tasks) {
      if (!ACTIVE_TASK_STATUSES.includes(task.status)) continue
      await this.tasks.update(task.taskId, (current) => {
        markInterrupted(current, { reason: 'Host plugin stopped while the task was active' })
      }).catch(() => {})
      await this.appendEvent(task.taskId, 'task-interrupted', {
        hostId: this.hostId,
        reason: 'plugin stopped; Agent.cancel requested',
      }).catch(() => {})
    }
    // Drain owned Agents and in-flight round finalizers before removing the
    // scoped listeners; a timeout keeps an optional plugin from hanging the
    // whole Desktop shutdown.
    await this.drainAgents([...agents])
    await this.drainRounds()
    this.disposeOwnedListeners()
    await this.writeHost('stopped').catch(() => {})
    return undefined
  }

  async drainAgents(agents) {
    const waits = agents
      .filter((agent) => typeof agent?.whenIdle === 'function')
      .map((agent) => Promise.resolve(agent.whenIdle()).catch(() => undefined))
    if (waits.length === 0) return
    await this.withTimeout(Promise.allSettled(waits), 10000, 'Agent drain')
  }

  async drainRounds() {
    if (this.roundRuns.size === 0) return
    await this.withTimeout(Promise.allSettled([...this.roundRuns]), 10000, 'round drain')
  }

  async withTimeout(promise, timeoutMs, label) {
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        this.log('warn', `${label} timed out after ${timeoutMs}ms`)
        resolve('timeout')
      }, timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  disposeOwnedListeners() {
    for (const dispose of this.hostListenerDisposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        this.log('warn', `host listener disposal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const agent of this.ownedAgents) {
      const disposers = this.agentListenerDisposers.get(agent) ?? []
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch (error) {
          this.log('warn', `Agent listener disposal failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    this.ownedAgents.clear()
  }

  async writeHost(state, extra = {}) {
    const missing = REQUIRED_SERVICES.filter((name) => {
      try {
        return this.ctx.get(name) === undefined
      } catch {
        return true
      }
    })
    const body = {
      schema: SCHEMA,
      pluginVersion: PLUGIN_VERSION,
      hostId: this.hostId,
      pid: process.pid,
      state,
      startedAt: this.startedAt,
      updatedAt: nowIso(),
      missingServices: missing,
      config: {
        controlDir: this.config.controlDir,
        controlRoot: this.config.controlRoot,
        allowedRoot: this.config.allowedRoot,
        agentPreset: this.config.agentPreset,
        permissionPreset: this.config.permissionPreset ?? null,
        decisionTimeoutMs: this.config.decisionTimeoutMs,
      },
      ...extra,
    }
    await atomicWriteJson(this.layout.host, body)
  }

  async appendEvent(taskId, type, data = {}) {
    await appendJsonl(path.join(this.layout.events, `${taskId}.jsonl`), {
      at: nowIso(),
      type,
      data,
    })
  }

  /**
   * Capture the exact normalized arguments of an owned tool call. Both the
   * pre-execute gate (which may itself ask for approval) and the around-dispatch
   * wrapper expose the same frozen `exec`; `tools/result` removes the entry for
   * every terminal path, including a pre-execute denial.
   */
  rememberToolCall(exec) {
    const sessionId = exec?.agent?.id
    if (typeof sessionId !== 'string' || !this.sessionIndex.has(sessionId)) return null
    const callId = exec.callId
    if (typeof callId !== 'string' || callId === '') return null
    const toolCall = {
      name: exec.name,
      callId,
      rootCallId: typeof exec.rootCallId === 'string' ? exec.rootCallId : callId,
      parentCallId: typeof exec.parent?.callId === 'string' ? exec.parent.callId : null,
      arguments: exec.arguments,
    }
    this.toolExecutions.set(`${sessionId}:${callId}`, toolCall)
    return toolCall
  }

  capturePreExecute(exec, next) {
    this.rememberToolCall(exec)
    try {
      return next()
    } catch (error) {
      this.forgetToolExecution(exec)
      throw error
    }
  }

  captureToolExecution(exec, next) {
    const toolCall = this.rememberToolCall(exec)
    if (!toolCall) return next()
    const key = `${exec.agent.id}:${toolCall.callId}`
    return (async () => {
      try {
        return await next()
      } finally {
        this.toolExecutions.delete(key)
      }
    })()
  }

  forgetToolExecution(exec) {
    const sessionId = exec?.agent?.id
    const callId = exec?.callId
    if (typeof sessionId === 'string' && typeof callId === 'string') {
      this.toolExecutions.delete(`${sessionId}:${callId}`)
    }
  }

  attachApprovalListener(agent, taskId, sessionId) {
    if (!agent || typeof agent.ctx?.on !== 'function') return false
    if (this.approvalAttached.has(agent)) return true
    this.approvalAttached.add(agent)
    this.ownedAgents.add(agent)
    const dispose = agent.ctx.on(
      'approval/request',
      (req, next) => this.onOwnedApproval(taskId, sessionId, req, next),
      { prepend: true },
    )
    this.addAgentDisposer(agent, dispose)
    return true
  }

  /**
   * Host-level capture and lifecycle listeners. The `agent/created` listener is
   * process-wide because a cold resume happens inside `sessionController` before
   * this runtime can see the handle, but it ignores every Agent absent from this
   * runtime's own `sessionIndex`; it can never install anything on, or take
   * over, a human Session.
   */
  installHostListeners() {
    if (this.hostListenersInstalled) return
    this.hostListenersInstalled = true
    if (typeof this.ctx.on !== 'function') return
    const listen = (name, listener, options) => {
      const dispose = this.ctx.on(name, listener, options)
      if (typeof dispose === 'function') this.hostListenerDisposers.push(dispose)
    }
    listen('tools/pre-execute', (exec, next) => this.capturePreExecute(exec, next), { prepend: true })
    listen('tools/execute', (exec, next) => this.captureToolExecution(exec, next))
    listen('tools/result', (exec) => this.forgetToolExecution(exec))
    // The installed Desktop forwards approval/request through a root waterfall
    // listener (dsh-api-remotes). A root prepended listener is the supported
    // interception point; it is still filtered to this runtime's own session
    // index, and every foreign Session continues through next() untouched.
    listen('approval/request', (req, next) => this.onAnyApproval(req, next), {
      prepend: true,
      global: true,
    })
    listen('agent/created', (payload) => this.onAgentCreated(payload))
  }

  async onAnyApproval(req, next) {
    const sessionId = req?.agent?.session?.id ?? req?.agent?.id
    const taskId = typeof sessionId === 'string' ? this.sessionIndex.get(sessionId) : undefined
    if (taskId === undefined) return await next()
    return await this.onOwnedApproval(taskId, sessionId, req, next)
  }

  addAgentDisposer(agent, dispose) {
    if (typeof dispose !== 'function') return
    const disposers = this.agentListenerDisposers.get(agent) ?? []
    disposers.push(dispose)
    this.agentListenerDisposers.set(agent, disposers)
  }

  async ensureOwnedAgentHooks(task, agent, { phase, throwOnPermission = true } = {}) {
    if (!task || !agent || typeof agent.id !== 'string') return false
    this.ownedAgents.add(agent)
    this.sessionIndex.set(agent.id, task.taskId)
    if (!permissionBundleMatches(this.ctx.permissionPresets, agent.session, undefined)) {
      const permission = this.livePermissionName(agent)
      await this.appendEvent(task.taskId, 'permission-blocked', {
        phase,
        sessionId: agent.id,
        permission,
      }).catch(() => {})
      if (throwOnPermission) {
        throw new Error(
          `refusing session ${agent.id}: live permission is ${String(permission)}, not workspace-write/ask`,
        )
      }
      this.log('warn', `owned Agent ${agent.id} is ${String(permission)}; its steps will be rejected`)
    }
    this.installAgentGuards(agent, task.taskId)
    this.attachApprovalListener(agent, task.taskId, agent.id)
    return true
  }

  livePermissionName(agent) {
    try {
      return this.ctx.permissionPresets?.current?.(agent?.session) ?? null
    } catch {
      return null
    }
  }

  /**
   * Called from the serial `agent/created` event for a fresh or resumed Agent.
   * Only sessions already registered in `sessionIndex` are touched. A resumed
   * Agent whose live permission is not workspace-write + ask is rejected during
   * creation, so the first model step can never run under a wider UI mode.
   */
  async onAgentCreated(payload) {
    const agent = payload?.agent
    if (!agent || typeof agent.id !== 'string') return
    const taskId = this.sessionIndex.get(agent.id)
    if (taskId === undefined) return
    const task = await this.tasks.read(taskId)
    if (!task || task.session?.id !== agent.id) return
    await this.ensureOwnedAgentHooks(task, agent, { phase: 'agent-created', throwOnPermission: true })
  }

  /**
   * Install the per-Agent pre-step guard on the Agent's own scoped context.
   * `agent/pre-step` is the public waterfall in front of each model step; the
   * guard re-reads the live permission bundle every time, so a UI switch to
   * full access is rejected rather than silently inherited, including after a
   * cold resume. The guard is attached only to this plugin's own Agents.
   */
  installAgentGuards(agent, taskId) {
    if (!agent || typeof agent.ctx?.on !== 'function') return false
    if (this.permissionGuarded.has(agent)) return true
    this.permissionGuarded.add(agent)
    this.ownedAgents.add(agent)
    const sessionId = agent.id
    const dispose = agent.ctx.on(
      'agent/pre-step',
      async (payload, next) => {
        if (this.sessionIndex.get(sessionId) !== taskId) return { kind: 'reject' }
        if (!permissionBundleMatches(this.ctx.permissionPresets, agent.session, undefined)) {
          const step = Number.isInteger(payload?.step) ? payload.step : null
          await this.blockRoundForPermission(taskId, sessionId, step, this.livePermissionName(agent))
          return { kind: 'reject' }
        }
        return await next()
      },
      { prepend: true },
    )
    this.addAgentDisposer(agent, dispose)
    return true
  }

  /**
   * A pre-step permission failure is an execution failure, not an idle success.
   * Mark the active round failed before rejecting the step so the later
   * `whenIdle()` settlement cannot turn it into `completed`.
   */
  async blockRoundForPermission(taskId, sessionId, step, permission) {
    let failedRound = null
    await this.tasks.update(taskId, (current) => {
      if (current.session?.id !== sessionId) return false
      const round = current.activeRound
      if (round === null || round === undefined) return false
      if (!ACTIVE_TASK_STATUSES.includes(current.status)) return false
      const failed = markFailed(current, round, {
        error: new Error(
          `permission blocked before model step ${step ?? '?'}: ${String(permission)}, not workspace-write/ask`,
        ),
      })
      if (failed) failedRound = round
      return failed
    }).catch(() => {})
    if (failedRound !== null) {
      await this.appendEvent(taskId, 'permission-blocked', {
        phase: 'pre-step',
        sessionId,
        round: failedRound,
        step,
        permission,
        outcome: 'round failed closed; completion suppressed',
      }).catch(() => {})
    }
    return failedRound !== null
  }

  async pump() {
    if (this.stopping || this.pumping) return
    this.pumping = true
    try {
      const entries = await listJson(this.layout.commands)
      for (const entry of entries) {
        if (this.stopping) break
        if (!entry.value) {
          await this.finishBadCommand(entry.file, 'command file is not valid JSON')
          continue
        }
        const commandId = entry.value.commandId
        if (typeof commandId !== 'string' || this.activeCommands.has(commandId)) continue
        void this.handleCommand(entry.file, entry.value)
      }
    } finally {
      this.pumping = false
    }
  }

  async finishBadCommand(file, message) {
    const base = path.basename(file, '.json')
    await moveInto(file, this.layout.commandInvalid, base).catch(() => {})
    await atomicWriteJson(
      path.join(this.layout.commandResults, `${base}.json`),
      { schema: SCHEMA, commandId: base, status: 'error', error: message, at: nowIso() },
      { exclusive: false },
    ).catch(() => {})
  }

  async handleCommand(file, raw) {
    let command
    try {
      command = validateCommand(raw)
    } catch (error) {
      await this.finishBadCommand(file, `invalid command: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.activeCommands.add(command.commandId)
    try {
      const result = await this.dispatch(command)
      await atomicWriteJson(path.join(this.layout.commandResults, `${command.commandId}.json`), {
        schema: SCHEMA,
        commandId: command.commandId,
        taskId: command.taskId,
        owner: command.owner,
        kind: command.kind,
        status: 'accepted',
        message: result?.message ?? 'accepted',
        at: nowIso(),
      })
      await moveInto(file, this.layout.commandsProcessed, `${command.commandId}.json`)
      await this.appendEvent(command.taskId, 'command-accepted', {
        commandId: command.commandId,
        owner: command.owner,
        kind: command.kind,
      }).catch(() => {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await atomicWriteJson(path.join(this.layout.commandResults, `${command.commandId}.json`), {
        schema: SCHEMA,
        commandId: command.commandId,
        taskId: command.taskId,
        owner: command.owner,
        kind: command.kind,
        status: 'error',
        error: message,
        at: nowIso(),
      }).catch(() => {})
      await moveInto(file, this.layout.commandsProcessed, `${command.commandId}.json`).catch(() => {})
      await this.appendEvent(command.taskId, 'command-rejected', {
        commandId: command.commandId,
        owner: command.owner,
        kind: command.kind,
        error: message,
      }).catch(() => {})
      this.log('warn', `command ${command.commandId} failed: ${message}`)
    } finally {
      this.activeCommands.delete(command.commandId)
    }
  }

  async dispatch(command) {
    if (command.kind === 'start') {
      return await this.withTaskLock(command.taskId, () => this.startTask(command))
    }
    if (command.kind === 'continue') {
      return await this.withTaskLock(command.taskId, () => this.continueTask(command))
    }
    if (command.kind === 'cancel') {
      return await this.withTaskLock(command.taskId, () => this.cancelTask(command))
    }
    throw new Error(`unsupported command kind ${command.kind}`)
  }

  withTaskLock(taskId, fn) {
    const previous = this.taskChains.get(taskId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    this.taskChains.set(taskId, next.then(() => undefined, () => undefined))
    return next
  }

  async startTask(command) {
    const existing = await this.tasks.read(command.taskId)
    if (existing) {
      if (existing.createdByCommandId === command.commandId && existing.owner === command.owner) {
        return { message: `task ${command.taskId} was already created by this command` }
      }
      throw new Error(`task ${command.taskId} already exists under owner ${existing.owner}`)
    }
    // Validate every external input before creating anything durable.
    const permissionName = selectPermissionPreset(this.ctx.permissionPresets, this.config.permissionPreset)
    const requestedCwd = validateCommandCwd(command.cwd, this.config.allowedRoot)
    let canonicalCwd
    try {
      canonicalCwd = await fs.realpath(requestedCwd)
      const stat = await fs.stat(canonicalCwd)
      if (!stat.isDirectory()) throw new Error('not a directory')
    } catch (error) {
      throw new Error(`task cwd must be an existing directory: ${requestedCwd}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const requestedTitle = typeof command.title === 'string' ? command.title.trim() : ''
    const taskTitle =
      requestedTitle === ''
        ? undefined
        : requestedTitle.startsWith('Codex 委派')
          ? requestedTitle
          : `Codex 委派 · ${requestedTitle}`
    const task = createTaskRecord({
      taskId: command.taskId,
      title: taskTitle,
      prompt: command.prompt,
      commandId: command.commandId,
      owner: command.owner,
      hostId: this.hostId,
    })
    task.workspace = { id: null, path: canonicalCwd }
    await this.tasks.create(task)
    await this.appendEvent(task.taskId, 'task-created', {
      commandId: command.commandId,
      owner: command.owner,
      cwd: canonicalCwd,
      agentPreset: this.config.agentPreset,
      permissionPreset: permissionName,
    })
    try {
      await this.tasks.update(task.taskId, (current) => {
        if (current.status !== 'creating') {
          throw new Error(`task ${task.taskId} is ${current.status}; refusing to create it twice`)
        }
        current.hostId = this.hostId
      })
      const workspace = await this.ctx.workspaceRegistry.create(canonicalCwd, this.config.workspaceTitle)
      await this.tasks.update(task.taskId, (current) => {
        current.workspace = { id: workspace.id, path: workspace.path }
      })
      const created = await this.ctx.sessionController.create({
        workspaceId: workspace.id,
        agentPreset: this.config.agentPreset,
      })
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('sessionController.create returned no sessionId')
      }
      if (created.agentPreset !== this.config.agentPreset) {
        throw new Error(
          `sessionController.create ran preset "${String(created.agentPreset)}", expected "${this.config.agentPreset}"; refusing to prompt without the configured preset`,
        )
      }
      const agent = this.ctx.agents.get(sessionId)
      const session = agent?.session ?? this.ctx.sessions.get(sessionId)
      if (!session) throw new Error(`created session ${sessionId} is not live`)
      this.ctx.permissionPresets.set(session, permissionName)
      if (!permissionBundleMatches(this.ctx.permissionPresets, session, permissionName)) {
        throw new Error(
          `created session ${sessionId} did not retain the ${permissionName} bundle (workspace-write + ask)`,
        )
      }
      await this.ensureOwnedAgentHooks(task, agent, { phase: 'start', throwOnPermission: true })
      const warnings = []
      try {
        await this.ctx.sessionController.rename({
          sessionId,
          title: task.title,
        })
      } catch (error) {
        warnings.push(`rename failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      const round = await this.tasks.update(task.taskId, (current) => {
        current.session = {
          id: sessionId,
          agentPreset: created.agentPreset ?? this.config.agentPreset,
          permissionPreset: permissionName,
          permission: { sandbox: 'workspace-write', approval: 'ask' },
        }
        current.warnings.push(...warnings)
        beginFirstRound(current, {
          commandId: command.commandId,
          prompt: command.prompt,
        })
        return current.activeRound
      })
      this.sessionIndex.set(sessionId, task.taskId)
      await this.appendEvent(task.taskId, 'session-created', {
        sessionId,
        workspaceId: workspace.id,
        cwd: workspace.path,
        owner: task.owner,
        agentPreset: created.agentPreset ?? this.config.agentPreset,
        permissionPreset: permissionName,
        round,
      })
      this.trackRound(task.taskId, round)
      return { message: `session ${sessionId} created in ${workspace.path}; round ${round} started` }
    } catch (error) {
      await this.tasks.update(task.taskId, (current) => {
        markFailed(current, current.activeRound, { error })
      }).catch(() => {})
      await this.appendEvent(task.taskId, 'task-failed', {
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
      throw error
    }
  }

  async continueTask(command) {
    const task = await this.tasks.read(command.taskId)
    if (!task) throw new Error(`task ${command.taskId} does not exist`)
    if (command.owner !== task.owner) {
      throw new Error(`owner mismatch: task ${task.taskId} belongs to ${task.owner}`)
    }
    if (task.rounds.some((round) => round.commandId === command.commandId)) {
      return { message: `command ${command.commandId} already started a round` }
    }
    if (ACTIVE_TASK_STATUSES.includes(task.status)) {
      throw new Error(`task ${task.taskId} is ${task.status}; wait for it to end or cancel it first`)
    }
    if (!task.session?.id) throw new Error(`task ${task.taskId} has no session to continue`)
    const agent = this.ctx.agents.get(task.session.id)
    const warnings = []
    if (agent) {
      if (!permissionBundleMatches(this.ctx.permissionPresets, agent.session, task.session.permissionPreset)) {
        throw new Error(
          'refusing to continue: the live session permission no longer resolves to workspace-write + ask',
        )
      }
      await this.ensureOwnedAgentHooks(task, agent, { phase: 'continue', throwOnPermission: true })
    } else {
      await this.assertColdPermission(task)
    }
    const round = await this.tasks.update(task.taskId, (current) => {
      current.warnings.push(...warnings)
      beginRound(current, { commandId: command.commandId, prompt: command.prompt })
      return current.activeRound
    })
    this.sessionIndex.set(task.session.id, task.taskId)
    await this.appendEvent(task.taskId, 'round-begun', {
      round,
      commandId: command.commandId,
      owner: command.owner,
      permissionReverified: true,
      coldResume: agent === undefined,
    })
    this.trackRound(task.taskId, round)
    return { message: `round ${round} started on session ${task.session.id}` }
  }

  /**
   * A cold Session has no live Agent to read `permissionPresets.current` from.
   * `sessionQuery.observeSession` exposes the durable events and header; fold
   * the same sandbox/mode and approval/policy events the enforcement services
   * fold, then require exactly workspace-write + ask before prompting.
   */
  async assertColdPermission(task) {
    const sessionId = task.session.id
    let observation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId)
      if (!observation || observation.header?.id !== sessionId) {
        throw new Error('cold Session observation did not identify the requested Session')
      }
      if (!Array.isArray(observation.events)) {
        throw new Error('cold Session observation exposes no durable events; refusing to infer permission')
      }
      if (typeof observation.header.cwd !== 'string' || observation.header.cwd === '') {
        throw new Error('cold Session has no recorded cwd')
      }
      const expectedCwd = task.workspace?.path
      const actualCwd = await fs.realpath(observation.header.cwd).catch(() => observation.header.cwd)
      if (expectedCwd && actualCwd !== expectedCwd) {
        throw new Error(`cold Session cwd ${actualCwd} does not match task cwd ${expectedCwd}`)
      }
      // Root runtime does not inject Agent-scoped shell/approval services.
      // Cordis getters throw even with optional chaining. Require explicit
      // durable permission events; absence is unknown and fails closed.
      const effective = permissionFromEvents(observation.events)
      if (!mandatoryPermission(effective)) {
        throw new Error(
          `refusing cold continue: durable permission is ${String(effective.sandbox)}/${String(effective.approval)}, not workspace-write/ask`,
        )
      }
    } finally {
      try {
        observation?.[Symbol.dispose]?.()
      } catch {
        // observation lifetime is best-effort; no decision depends on it
      }
    }
  }

  async cancelTask(command) {
    const task = await this.tasks.read(command.taskId)
    if (!task) throw new Error(`task ${command.taskId} does not exist`)
    if (command.owner !== task.owner) {
      throw new Error(`owner mismatch: task ${task.taskId} belongs to ${task.owner}`)
    }
    if (!ACTIVE_TASK_STATUSES.includes(task.status)) {
      return { message: `task ${task.taskId} is already ${task.status}` }
    }
    // Mark the task cancelled first so a racing prompt failure cannot mark it
    // failed, then abort un-admitted prompt admission, then clear the whole
    // inbox with the public Agent.cancel() (no keepInbox).
    // sessionController.cancel() deliberately preserves queued work, so it is
    // not sufficient here.
    await this.tasks.update(task.taskId, (current) => {
      markCancelled(current, { reason: command.reason ?? 'cancelled by Codex' })
    })
    await this.appendEvent(task.taskId, 'cancel-requested', {
      commandId: command.commandId,
      owner: command.owner,
      reason: command.reason ?? 'cancelled by Codex',
    })
    for (const [key, abort] of this.roundAborts) {
      if (key.startsWith(`${task.taskId}:`)) {
        try {
          abort.abort(new Error('cancelled by Codex'))
        } catch {
          // already aborted
        }
      }
    }
    const sessionId = task.session?.id
    if (typeof sessionId === 'string') {
      this.cancelOwnedAgent(sessionId, command.reason ?? 'cancelled by Codex')
    }
    return { message: `task ${task.taskId} cancelled and its inbox cleared` }
  }

  /**
   * Stop this plugin's own live Agent. The public `Agent.cancel({kind:'user'})`
   * without `keepInbox` aborts the turn and clears queued/steering work; it is
   * never routed through another Session's controller or a UI answerer.
   */
  cancelOwnedAgent(sessionId, reason = 'cancelled by Codex') {
    const agent = this.ctx.agents.get(sessionId)
    if (!agent) return false
    try {
      agent.cancel({ kind: 'user' })
      return true
    } catch (error) {
      this.log('warn', `Agent.cancel(${sessionId}) failed (${reason}): ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  roundIsActive(task, round) {
    return Boolean(
      task &&
        task.activeRound === round &&
        !task.cancelRequested &&
        ACTIVE_TASK_STATUSES.includes(task.status),
    )
  }

  trackRound(taskId, round) {
    const promise = this.runRound(taskId, round)
      .catch((error) => this.log('warn', `round ${taskId}:${round} finalizer failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.roundRuns.delete(promise))
    this.roundRuns.add(promise)
    return promise
  }

  /**
   * Read one round's real Session events through the public Session query. Only
   * the plugin's own recorded session id is read, and only the round beginning
   * at this prompt's `rpcId` is kept. Request headers and unrelated Session
   * material are deliberately excluded.
   */
  async readRoundOutput(taskId, round, requestId, fallbackStatus = 'unknown') {
    const output = {
      schema: SCHEMA,
      kind: 'round-exchange',
      taskId,
      owner: null,
      round,
      requestId,
      sessionId: null,
      sessionSeq: null,
      roundStartSeq: null,
      roundEndSeq: null,
      capturedAt: nowIso(),
      source: 'ctx.sessionQuery.observeSession (public Session API)',
      status: fallbackStatus,
      finalReply: null,
      turnEnd: null,
      eventCount: 0,
      events: [],
    }
    const task = await this.tasks.read(taskId).catch(() => null)
    output.owner = task?.owner ?? null
    const sessionId = task?.session?.id
    if (typeof sessionId !== 'string') {
      output.status = task?.status ?? fallbackStatus
      output.note = 'task has no recorded Session'
      return output
    }
    output.sessionId = sessionId
    let observation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId)
      if (!observation || observation.header?.id !== sessionId || !Array.isArray(observation.events)) {
        throw new Error('public Session observation did not return this task Session and its events')
      }
      const events = observation.events
      output.sessionSeq = events.at(-1)?.seq ?? 0
      const startIndex = events.findIndex(
        (event) => event?.type === 'user/message' && event.data?.source?.rpcId === requestId,
      )
      const roundEvents = startIndex >= 0 ? events.slice(startIndex) : []
      const allowed = new Set([
        'user/message',
        'assistant/message',
        'assistant/attempt',
        'tool/result',
        'turn/start',
        'turn/end',
        'step/start',
        'step/end',
      ])
      const kept = roundEvents
        .filter((event) => allowed.has(event?.type))
        .map((event) => ({
          seq: event.seq,
          time: event.time,
          type: event.type,
          data: event.data,
        }))
      const turnEnd = [...kept].reverse().find((event) => event.type === 'turn/end') ?? null
      const finalMessage = [...kept].reverse().find((event) => event.type === 'assistant/message') ?? null
      const content = finalMessage?.data?.message?.content ?? null
      output.roundStartSeq = kept[0]?.seq ?? null
      output.roundEndSeq = kept.at(-1)?.seq ?? null
      output.eventCount = kept.length
      output.events = kept
      output.turnEnd = turnEnd
        ? {
            seq: turnEnd.seq,
            turn: turnEnd.data?.turn ?? null,
            reason: turnEnd.data?.reason ?? null,
          }
        : null
      output.finalReply = finalMessage
        ? {
            seq: finalMessage.seq,
            turn: finalMessage.data?.turn ?? null,
            step: finalMessage.data?.step ?? null,
            content,
            text: Array.isArray(content)
              ? content
                  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
                  .map((block) => block.text)
                  .join('\n')
              : '',
          }
        : null
      if (task && !ACTIVE_TASK_STATUSES.includes(task.status)) output.status = task.status
      else if (turnEnd) {
        output.status = turnEnd.data?.reason?.kind === 'completed' ? 'completed' : 'failed'
      } else {
        output.status = fallbackStatus
      }
      return output
    } catch (error) {
      output.status = task?.status ?? fallbackStatus
      output.captureError = error instanceof Error ? error.message : String(error)
      return output
    } finally {
      try {
        observation?.[Symbol.dispose]?.()
      } catch {
        // observation lifetime is best-effort; the stored output is already detached
      }
    }
  }

  async writeRoundOutput(output) {
    const file = path.join(this.layout.outputs, `${output.taskId}-round-${output.round}.json`)
    output.outputPath = file
    await atomicWriteJson(file, output)
    await this.tasks.update(output.taskId, (current) => {
      const record = current.rounds.find((item) => item.round === output.round)
      if (record) {
        record.outputPath = file
        record.outputStatus = output.status
        record.outputCapturedAt = output.capturedAt
      }
    }).catch(() => {})
    await this.appendEvent(output.taskId, 'round-output', {
      round: output.round,
      status: output.status,
      outputPath: file,
      sessionId: output.sessionId,
      sessionSeq: output.sessionSeq,
      source: output.source,
    }).catch(() => {})
    return file
  }

  async runRound(taskId, round) {
    const task = await this.tasks.read(taskId)
    if (!this.roundIsActive(task, round)) return
    const roundRecord = task.rounds.find((item) => item.round === round)
    if (!roundRecord) return
    const sessionId = task.session?.id
    if (typeof sessionId !== 'string') return
    const requestId = `rpc-${taskId}-${round}-${randomUUID().slice(0, 8)}`
    const abort = new AbortController()
    const key = `${taskId}:${round}`
    this.roundAborts.set(key, abort)
    let exchange = null
    try {
      // A cancel may have landed between the caller's `void runRound(...)` and
      // this admission. Check the durable flag again before queueing anything.
      const beforePrompt = await this.tasks.read(taskId)
      if (!this.roundIsActive(beforePrompt, round) || abort.signal.aborted) {
        this.cancelOwnedAgent(sessionId, 'round was cancelled before prompt admission')
        return
      }
      await this.ctx.sessionController.prompt(
        {
          sessionId,
          requestId,
          content: [{ type: 'text', text: roundRecord.prompt }],
        },
        abort.signal,
      )
      // Cancellation can race prompt admission: the service may enqueue the
      // followup just after the cancel command cleared the inbox. Close that
      // race by checking the durable cancellation flag and clearing the inbox
      // once more before declaring the round live.
      const afterPrompt = await this.tasks.read(taskId)
      if (!this.roundIsActive(afterPrompt, round) || abort.signal.aborted) {
        this.cancelOwnedAgent(sessionId, 'cancelled during prompt admission')
        await this.appendEvent(taskId, 'prompt-discarded', {
          round,
          requestId,
          reason: 'task was cancelled at or before prompt admission',
        }).catch(() => {})
        return
      }
      const agent = this.ctx.agents.get(sessionId)
      if (!agent) throw new Error(`session ${sessionId} has no live agent after prompt admission`)
      // A cold resume creates the real Agent inside sessionController.prompt.
      // Re-verify its live bundle once more before waiting on model work; the
      // agent/created guard and the pre-step guard cover the earlier boundary.
      if (!permissionBundleMatches(this.ctx.permissionPresets, agent.session, undefined)) {
        await this.appendEvent(taskId, 'permission-blocked', {
          phase: 'post-prompt',
          sessionId,
          permission: this.livePermissionName(agent),
        }).catch(() => {})
        this.cancelOwnedAgent(sessionId, 'live permission was not workspace-write + ask')
        throw new Error(`refusing round ${round}: live permission is ${String(this.livePermissionName(agent))}, not workspace-write/ask`)
      }
      this.installAgentGuards(agent, taskId)
      this.attachApprovalListener(agent, taskId, sessionId)
      let accepted = false
      await this.tasks.update(taskId, (current) => {
        if (!this.roundIsActive(current, round)) return
        markRoundAccepted(current, round, { requestId })
        accepted = true
      })
      if (!accepted) {
        this.cancelOwnedAgent(sessionId, 'round was cancelled during prompt acknowledgement')
        return
      }
      await this.appendEvent(taskId, 'prompt-accepted', { round, requestId })
      await this.raceWithStop(agent.whenIdle())
      if (this.stopping) return
      exchange = await this.readRoundOutput(taskId, round, requestId, 'running')
      const turnKind = exchange.turnEnd?.reason?.kind ?? null
      let settled = false
      const completed = await this.tasks.update(taskId, (current) => {
        if (!this.roundIsActive(current, round)) return false
        if (turnKind !== 'completed') {
          settled = markFailed(current, round, {
            error: new Error(
              turnKind
                ? `turn ended with ${turnKind}; not treated as completed`
                : 'no turn/end event was observed for the round; not treated as completed',
            ),
          })
          return settled
        }
        settled = markCompleted(current, round, { basis: 'agent.whenIdle + turn/end:completed' })
        return settled
      })
      if (completed) {
        await this.appendEvent(taskId, 'round-idle', {
          round,
          basis: 'agent.whenIdle + turn/end:completed',
          turnEnd: exchange.turnEnd,
          note: 'execution ended; independent acceptance is a separate review file',
        })
      } else if (settled) {
        await this.appendEvent(taskId, 'round-failed', {
          round,
          error: turnKind ? `turn ended with ${turnKind}` : 'no turn/end event observed',
          turnEnd: exchange.turnEnd,
        })
      }
    } catch (error) {
      if (!this.stopping) {
        await this.tasks.update(taskId, (current) => {
          if (current.activeRound !== round) return false
          return markFailed(current, round, { error })
        }).catch(() => {})
        await this.appendEvent(taskId, 'round-failed', {
          round,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      }
    } finally {
      try {
        if (!exchange) exchange = await this.readRoundOutput(taskId, round, requestId, 'unknown')
        const current = await this.tasks.read(taskId).catch(() => null)
        if (current?.status) exchange.status = current.status
        await this.writeRoundOutput(exchange)
      } catch (error) {
        this.log('warn', `could not write round output for ${taskId}:${round}: ${error instanceof Error ? error.message : String(error)}`)
        await this.appendEvent(taskId, 'round-output-failed', {
          round,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      }
      this.roundAborts.delete(key)
    }
  }

  raceWithStop(promise) {
    return Promise.race([promise, this.stopPromise])
  }

  /**
   * Registered on the created Agent's scoped context. An owned Session whose
   * task is no longer active is rejected, never delegated to the Desktop UI,
   * so a late request cannot execute through another answerer.
   */
  async onOwnedApproval(taskId, sessionId, req, next) {
    try {
      const task = await this.tasks.read(taskId)
      if (!task || task.session?.id !== sessionId) return 'rejected'
      if (!isOwnedApproval(task, req)) {
        await this.appendEvent(taskId, 'approval-rejected', {
          reason: 'late or inactive approval on a Codex-owned Session',
          toolName: typeof req?.toolName === 'string' ? req.toolName : undefined,
          callId: typeof req?.callId === 'string' ? req.callId : undefined,
        }).catch(() => {})
        return 'rejected'
      }
      return await this.handleApproval(task, req)
    } catch (error) {
      this.log('warn', `approval handling failed closed: ${error instanceof Error ? error.message : String(error)}`)
      return 'rejected'
    }
  }

  async handleApproval(task, req) {
    const fresh = await this.tasks.read(task.taskId)
    if (!fresh || !isOwnedApproval(fresh, req)) {
      await this.appendEvent(task.taskId, 'approval-rejected', {
        reason: 'task became inactive before the approval was queued',
        toolName: typeof req?.toolName === 'string' ? req.toolName : undefined,
        callId: typeof req?.callId === 'string' ? req.callId : undefined,
      }).catch(() => {})
      return 'rejected'
    }
    task = fresh
    const round = task.activeRound
    const callId = typeof req?.callId === 'string' ? req.callId : null
    let toolCall
    try {
      if (callId === null) throw new Error('approval request carries no callId')
      toolCall = assertCompleteToolCall(this.toolExecutions.get(`${task.session.id}:${callId}`))
      if (toolCall.name !== req.toolName) {
        throw new Error(`tool name mismatch: execution=${toolCall.name} approval=${String(req.toolName)}`)
      }
    } catch (error) {
      await this.appendEvent(task.taskId, 'approval-unresolved', {
        round,
        callId,
        toolName: typeof req?.toolName === 'string' ? req.toolName : undefined,
        reason: error instanceof Error ? error.message : String(error),
        outcome: 'rejected without queueing (arguments cannot be reviewed)',
      }).catch(() => {})
      return 'rejected'
    }
    const requestId = newId('apr')
    const record = buildApprovalRecord({
      requestId,
      task,
      round,
      req,
      toolCall,
      hostId: this.hostId,
      timeoutMs: this.config.decisionTimeoutMs,
    })
    await writeApprovalRequest(this.config.controlDir, record)
    let result = { outcome: 'rejected', reason: 'approval handling did not complete' }
    try {
      await this.tasks.update(task.taskId, (current) => {
        if (current.activeRound !== round) return
        markAwaiting(current, round, { requestId })
      })
      await this.appendEvent(task.taskId, 'approval-requested', {
        requestId,
        round,
        toolName: record.toolName,
        callId: record.callId,
        owner: task.owner,
      })
      result = await waitForDecision({
        controlDir: this.config.controlDir,
        requestId,
        owner: task.owner,
        timeoutMs: this.config.decisionTimeoutMs,
        pollIntervalMs: Math.min(this.config.pollIntervalMs, 500),
        signal: req.signal,
        isStopping: () => this.stopping,
      })
    } catch (error) {
      result = {
        outcome: 'rejected',
        reason: `approval wait failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      await resolveApprovalFile({
        controlDir: this.config.controlDir,
        requestId,
        outcome: result.outcome,
        reason: result.reason ?? null,
      }).catch((error) => this.log('warn', `could not resolve approval file ${requestId}: ${error}`))
      await this.tasks.update(task.taskId, (current) => {
        markApprovalResolved(current, requestId, {
          outcome: result.outcome,
          reason: result.reason ?? null,
        })
      }).catch(() => {})
      await this.appendEvent(task.taskId, 'approval-resolved', {
        requestId,
        round,
        outcome: result.outcome,
        reason: result.reason ?? null,
      }).catch(() => {})
    }
    return result.outcome
  }

  log(level, message) {
    const logger = this.ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](`[codex-native-delegate] ${message}`)
  }
}

export { PLUGIN_VERSION }
export default DelegationRuntime
