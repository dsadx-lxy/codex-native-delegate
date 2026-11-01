// Offline simulation of the Host-facing control flow. This is NOT a Desktop
// test: it replaces the Cordis services with small fakes so the task/approval
// protocol can be exercised without installing the plugin or launching a model.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DelegationRuntime } from '../native/plugin/runtime.mjs'
import { validatePluginConfig } from '../native/plugin/lib/policy.mjs'
import {
  buildCancelCommand,
  buildContinueCommand,
  buildDecision,
  buildStartCommand,
} from '../native/plugin/lib/commands.mjs'
import {
  atomicWriteJson,
  controlLayout,
  listJson,
  readJson,
} from '../native/plugin/lib/store.mjs'

class FakeAgentCtx {
  constructor() {
    this.approval = []
    this.approvalOptions = null
    this.preStep = []
    this.preStepOptions = null
  }
  on(name, listener, options) {
    if (name === 'approval/request') {
      this.approval.push(listener)
      this.approvalOptions = options ?? null
      return () => {
        this.approval = this.approval.filter((item) => item !== listener)
      }
    }
    if (name === 'agent/pre-step') {
      this.preStep.push(listener)
      this.preStepOptions = options ?? null
      return () => {
        this.preStep = this.preStep.filter((item) => item !== listener)
      }
    }
    return () => {}
  }
  async runPreStep(payload, next) {
    let index = 0
    const dispatch = async () => {
      const listener = this.preStep[index]
      index += 1
      if (!listener) return await next()
      return await listener(payload, dispatch)
    }
    return await dispatch()
  }
  off() {}
}

class FakeAgent {
  constructor(session) {
    this.id = session.id
    this.session = session
    this.ctx = new FakeAgentCtx()
    this.cancelCalls = []
    this.inbox = []
    this.turn = 0
    this.step = 0
    this.openTurn = null
    this.resetIdle()
  }
  resetIdle() {
    this.idle = new Promise((resolve) => {
      this.resolveIdle = resolve
    })
  }
  whenIdle() {
    return this.idle
  }
  beginTurn(request) {
    this.turn += 1
    this.step = 1
    this.openTurn = this.turn
    this.session.append('user/message', {
      role: 'user',
      content: request.content,
      source: { kind: 'user', rpcId: request.requestId },
    })
    this.session.append('turn/start', { turn: this.turn })
    this.session.append('step/start', { turn: this.turn, step: this.step })
  }
  finish(reason = { kind: 'completed' }) {
    if (this.openTurn !== null) {
      if (reason.kind === 'completed') {
        this.session.append('assistant/message', {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `fake reply for turn ${this.openTurn}` }],
          },
          turn: this.openTurn,
          step: this.step,
        })
      }
      this.session.append('step/end', { turn: this.openTurn, step: this.step })
      this.session.append('turn/end', { turn: this.openTurn, reason })
      this.openTurn = null
    }
    this.resolveIdle?.()
  }
  cancel(cause, options) {
    this.cancelCalls.push({ cause, options })
    this.inbox.length = 0
    this.finish({ kind: 'aborted' })
    return { accepted: true }
  }
}

function makeSession(id, cwd) {
  return {
    id,
    seq: 0,
    header: { id, cwd },
    events: [],
    append(type, data) {
      this.seq += 1
      this.events.push({ seq: this.seq, time: new Date().toISOString(), type, data })
    },
  }
}

function makeHost(options = {}) {
  const { promptGate } = options
  const sessions = new Map()
  const agents = new Map()
  const workspaces = new Map()
  let created = 0
  const ctx = {
    toolsListeners: [],
    preToolListeners: [],
    createdListeners: [],
    approvalListeners: [],
    approvalOptions: null,
    logger: { info() {}, warn() {}, error() {} },
    on(name, listener, options) {
      const bucket =
        name === 'tools/execute'
          ? ctx.toolsListeners
          : name === 'tools/pre-execute'
            ? ctx.preToolListeners
            : name === 'agent/created'
              ? ctx.createdListeners
              : name === 'approval/request'
                ? ctx.approvalListeners
                : null
      if (!bucket) return () => {}
      if (name === 'approval/request') ctx.approvalOptions = options ?? null
      bucket.push(listener)
      return () => {
        const index = bucket.indexOf(listener)
        if (index >= 0) bucket.splice(index, 1)
      }
    },
    async emit(name, payload) {
      if (name !== 'agent/created') return
      for (const listener of [...ctx.createdListeners]) await listener(payload)
    },
    off() {},
    get(name) {
      return ctx[name]
    },
  }
  const sessionController = {
    async create({ workspaceId, agentPreset }) {
      const workspace = workspaces.get(workspaceId)
      created += 1
      const session = makeSession(`session-${created}`, workspace.path)
      sessions.set(session.id, session)
      agents.set(session.id, new FakeAgent(session))
      return { sessionId: session.id, agentPreset }
    },
    async prompt(request, signal) {
      if (promptGate) await promptGate(request, signal)
      let agent = agents.get(request.sessionId)
      if (!agent) {
        const session = sessions.get(request.sessionId)
        if (!session) throw new Error(`fake prompt: no session for ${request.sessionId}`)
        agent = new FakeAgent(session)
        agents.set(session.id, agent)
        await ctx.emit('agent/created', { agent, source: 'resume' })
      }
      agent.prompt = request
      agent.inbox.push(request)
      agent.beginTurn(request)
      agent.resetIdle()
      return { accepted: true }
    },
    async rename({ sessionId, title }) {
      sessions.get(sessionId).title = title
      return { title, seq: 0 }
    },
  }
  const workspaceRegistry = {
    async create(cwd, title) {
      const workspace = {
        id: `ws-${workspaces.size + 1}`,
        path: cwd,
        title,
        sessionIds: [],
      }
      workspaces.set(workspace.id, workspace)
      return workspace
    },
    get(id) {
      return workspaces.get(id)
    },
    list() {
      return [...workspaces.values()]
    },
  }
  const permissionPresets = {
    names: ['workspace-write', 'danger-full-access'],
    resolve(name) {
      if (name === 'workspace-write') return { sandbox: 'workspace-write', approval: 'ask' }
      if (name === 'danger-full-access') return { sandbox: 'danger-full-access', approval: 'never' }
      throw new Error(`unknown preset ${name}`)
    },
    current(session) {
      return session.permissionPreset ?? 'workspace-write'
    },
    set(session, name) {
      const spec = permissionPresets.resolve(name)
      session.permissionPreset = name
      session.append('permission/preset', { preset: name })
      session.append('sandbox/mode', { mode: spec.sandbox })
      session.append('approval/policy', { policy: spec.approval })
    },
  }
  const sessionQuery = {
    async observeSession(id) {
      const session = sessions.get(id)
      if (!session) throw new Error(`fake sessionQuery: no session ${id}`)
      return {
        header: session.header,
        events: session.events,
        [Symbol.dispose]() {},
      }
    },
  }
  Object.assign(ctx, {
    agents: {
      get(id) {
        return agents.get(id)
      },
    },
    sessions: {
      get(id) {
        return sessions.get(id)
      },
      list() {
        return [...sessions.values()]
      },
    },
    sessionController,
    workspaceRegistry,
    permissionPresets,
    sessionQuery,
    shell: { sandboxMode: 'workspace-write' },
    approval: { config: { policy: 'ask' } },
  })
  return { ctx, sessions, agents }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('offline simulation timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function removeOwnedTemp(root) {
  const realRoot = await fs.realpath(root)
  const realTmp = await fs.realpath(os.tmpdir())
  assert.equal(path.dirname(realRoot), realTmp, 'temporary tree is directly under os.tmpdir()')
  assert.ok(path.basename(realRoot).startsWith('dsh-codex-runtime-'), 'temporary tree carries the suite prefix')
  await fs.rm(realRoot, { recursive: true, force: true })
}

async function preparedRuntime(hostOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-runtime-'))
  const controlDir = path.join(root, 'control')
  const config = validatePluginConfig({
    controlDir,
    controlRoot: root,
    allowedRoot: root,
    agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    decisionTimeoutMs: 2000,
    pollIntervalMs: 10,
    heartbeatMs: 1000,
  })
  const host = makeHost(hostOptions)
  const runtime = new DelegationRuntime(host.ctx, config)
  const layout = controlLayout(controlDir)
  const cwd = await fs.mkdtemp(path.join(root, 'project-'))
  return {
    ...host,
    root,
    config,
    runtime,
    layout,
    cwd,
    taskFile: path.join(layout.tasks, 'task-1.json'),
  }
}

test('offline Host flow: create, exact approval, continue, owner check, cancel', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-runtime-'))
  const controlDir = path.join(root, 'control')
  const config = validatePluginConfig({
    controlDir,
    controlRoot: root,
    allowedRoot: root,
    agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    decisionTimeoutMs: 2000,
    pollIntervalMs: 10,
    heartbeatMs: 1000,
  })
  const { ctx, agents } = makeHost()
  const runtime = new DelegationRuntime(ctx, config)
  const layout = controlLayout(controlDir)
  const taskFile = path.join(layout.tasks, 'task-1.json')
  try {
    await runtime.start()
    const cwd = await fs.mkdtemp(path.join(root, 'project-'))
    await runtime.dispatch(
      buildStartCommand({
        taskId: 'task-1',
        owner: 'owner-thread-1',
        cwd,
        prompt: 'first task',
        title: 'Codex 委派 · 原生连接验证',
      }),
    )
    const task = await waitFor(async () => {
      const value = await readJson(taskFile)
      return value?.status === 'running' ? value : null
    })
    assert.equal(task.title, 'Codex 委派 · 原生连接验证')
    assert.equal(task.owner, 'owner-thread-1')
    assert.equal(task.workspace.path, cwd)
    assert.equal(task.session.permissionPreset, 'workspace-write')
    assert.deepEqual(task.session.permission, { sandbox: 'workspace-write', approval: 'ask' })
    const agent = agents.get(task.session.id)
    assert.ok(agent, 'fake agent exists')
    assert.equal(ctx.toolsListeners.length, 1, 'tools/execute listener installed')
    assert.equal(ctx.preToolListeners.length, 1, 'tools/pre-execute listener installed')
    assert.equal(ctx.approvalListeners.length, 1, 'root approval bridge installed')
    assert.deepEqual(ctx.approvalOptions, { prepend: true, global: true })
    assert.equal(agent.ctx.approval.length, 1, 'Agent-scoped approval listener installed')
    assert.deepEqual(agent.ctx.approvalOptions, { prepend: true }, 'approval listener runs before UI answerers')
    assert.equal(agent.ctx.preStep.length, 1, 'Agent-scoped pre-step permission guard installed')
    assert.deepEqual(agent.ctx.preStepOptions, { prepend: true })

    let approvalResult
    const toolPromise = ctx.toolsListeners[0](
      {
        agent,
        name: 'pwsh',
        callId: 'call-1',
        rootCallId: 'call-1',
        arguments: { command: 'node --test', cwd },
      },
      async () => {
        approvalResult = ctx.approvalListeners[0](
          {
            agent,
            toolName: 'pwsh',
            callId: 'call-1',
            reason: 'run the test suite',
          },
          () => Promise.resolve('unavailable'),
        )
        return await approvalResult
      },
    )
    const pending = await waitFor(async () => {
      const items = await listJson(layout.approvals)
      return items[0]?.value
    })
    assert.equal(pending.owner, 'owner-thread-1')
    assert.equal(pending.operation.source, 'tools/execute:exec.arguments')
    assert.deepEqual(pending.operation.toolCall.arguments, { command: 'node --test', cwd })
    await atomicWriteJson(
      path.join(layout.decisions, `${pending.requestId}.json`),
      buildDecision({ requestId: pending.requestId, decision: 'allow', owner: 'owner-thread-1' }),
    )
    assert.equal(await approvalResult, 'allowed-once')
    assert.equal(await toolPromise, 'allowed-once')

    agent.finish()
    const completed = await waitFor(async () => {
      const value = await readJson(taskFile)
      return value?.status === 'completed' && value.rounds[0]?.outputPath ? value : null
    })
    assert.equal(completed.review, undefined)
    const output = await readJson(completed.rounds[0].outputPath)
    assert.equal(output.kind, 'round-exchange')
    assert.equal(output.sessionId, completed.session.id)
    assert.equal(output.source, 'ctx.sessionQuery.observeSession (public Session API)')
    assert.equal(output.status, 'completed')
    assert.equal(output.turnEnd.reason.kind, 'completed')
    assert.match(output.finalReply.text, /fake reply for turn 1/)
    assert.ok(output.roundStartSeq > 0)
    assert.ok(output.roundEndSeq >= output.roundStartSeq)
    assert.ok(output.events.some((event) => event.type === 'user/message'))
    assert.ok(output.events.some((event) => event.type === 'assistant/message'))
    assert.ok(output.events.some((event) => event.type === 'turn/end'))
    assert.ok(!output.events.some((event) => event.type === 'request/header'))

    await runtime.dispatch(
      buildContinueCommand({ taskId: 'task-1', owner: 'owner-thread-1', prompt: 'second round' }),
    )
    await waitFor(async () => {
      const value = await readJson(taskFile)
      return value?.rounds.length === 2 && value.status === 'running'
    })
    await assert.rejects(
      () =>
        runtime.dispatch(
          buildContinueCommand({ taskId: 'task-1', owner: 'owner-thread-1', prompt: 'too early' }),
        ),
      /is running/,
    )
    await assert.rejects(
      () =>
        runtime.dispatch(
          buildContinueCommand({ taskId: 'task-1', owner: 'other-owner', prompt: 'not allowed' }),
        ),
      /owner mismatch/,
    )
    await runtime.dispatch(
      buildCancelCommand({ taskId: 'task-1', owner: 'owner-thread-1', reason: 'stop' }),
    )
    const cancelled = await readJson(taskFile)
    assert.equal(cancelled.status, 'cancelled')
    assert.ok(agent.cancelCalls.length >= 1)
    for (const call of agent.cancelCalls) {
      assert.equal(call.options, undefined, 'Agent.cancel clears the inbox')
    }
    assert.equal(agent.inbox.length, 0)
  } finally {
    await runtime.shutdown()
    await removeOwnedTemp(root)
  }
})

test('root approval bridge forwards foreign sessions unchanged to the original UI chain', async () => {
  const p = await preparedRuntime()
  try {
    await p.runtime.start()
    await p.runtime.dispatch(
      buildStartCommand({ taskId: 'task-1', owner: 'owner-thread-1', cwd: p.cwd, prompt: 'first task' }),
    )
    await waitFor(async () => (await readJson(p.taskFile))?.status === 'running')
    let nextCalled = false
    const foreign = { id: 'human-session', session: { id: 'human-session' } }
    const result = await p.ctx.approvalListeners[0](
      { agent: foreign, toolName: 'pwsh', callId: 'foreign-call' },
      async () => {
        nextCalled = true
        return 'unavailable'
      },
    )
    assert.equal(nextCalled, true, 'foreign approval continues through next()')
    assert.equal(result, 'unavailable')
  } finally {
    await p.runtime.shutdown()
    await removeOwnedTemp(p.root)
  }
})

test('shutdown cancels the live self-built Agent and marks the task interrupted', async () => {
  const p = await preparedRuntime()
  try {
    await p.runtime.start()
    await p.runtime.dispatch(
      buildStartCommand({ taskId: 'task-1', owner: 'owner-thread-1', cwd: p.cwd, prompt: 'first task' }),
    )
    const task = await waitFor(async () => {
      const value = await readJson(p.taskFile)
      return value?.status === 'running' ? value : null
    })
    const agent = p.agents.get(task.session.id)
    await waitFor(() => agent.inbox.length === 1)
    await p.runtime.shutdown()
    const stopped = await readJson(p.taskFile)
    assert.equal(stopped.status, 'interrupted')
    assert.ok(agent.cancelCalls.length >= 1)
    for (const call of agent.cancelCalls) assert.equal(call.options, undefined)
    assert.equal(agent.inbox.length, 0)
  } finally {
    await removeOwnedTemp(p.root)
  }
})

test('hot unload disposes old Agent listeners and a new runtime resumes without them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-runtime-'))
  const controlDir = path.join(root, 'control')
  const config = validatePluginConfig({
    controlDir,
    controlRoot: root,
    allowedRoot: root,
    agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    decisionTimeoutMs: 2000,
    pollIntervalMs: 10,
    heartbeatMs: 1000,
  })
  const { ctx, agents } = makeHost()
  const layout = controlLayout(controlDir)
  const taskFile = path.join(layout.tasks, 'task-1.json')
  const runtime1 = new DelegationRuntime(ctx, config)
  let runtime2
  try {
    await runtime1.start()
    const cwd = await fs.mkdtemp(path.join(root, 'project-'))
    await runtime1.dispatch(
      buildStartCommand({ taskId: 'task-1', owner: 'owner-thread-1', cwd, prompt: 'first task' }),
    )
    const first = await waitFor(async () => {
      const value = await readJson(taskFile)
      return value?.status === 'running' ? value : null
    })
    const agent = agents.get(first.session.id)
    await waitFor(() => agent.inbox.length === 1)
    const oldApproval = agent.ctx.approval[0]
    const oldPreStep = agent.ctx.preStep[0]
    assert.equal(typeof oldApproval, 'function')
    assert.equal(typeof oldPreStep, 'function')

    await runtime1.shutdown()
    assert.equal((await readJson(taskFile)).status, 'interrupted')
    assert.equal(agent.ctx.approval.length, 0, 'old approval listener disposed')
    assert.equal(agent.ctx.preStep.length, 0, 'old pre-step listener disposed')
    assert.equal(ctx.toolsListeners.length, 0, 'old tools/execute listener disposed')
    assert.equal(ctx.preToolListeners.length, 0, 'old tools/pre-execute listener disposed')

    runtime2 = new DelegationRuntime(ctx, config)
    await runtime2.start()
    assert.equal(agent.ctx.approval.length, 1, 'new runtime installs its own approval listener')
    assert.equal(agent.ctx.preStep.length, 1, 'new runtime installs its own pre-step listener')
    assert.notEqual(agent.ctx.approval[0], oldApproval)
    assert.notEqual(agent.ctx.preStep[0], oldPreStep)
    assert.equal(ctx.toolsListeners.length, 1)
    assert.equal(ctx.preToolListeners.length, 1)

    await runtime2.dispatch(
      buildContinueCommand({ taskId: 'task-1', owner: 'owner-thread-1', prompt: 'second round' }),
    )
    await waitFor(async () => {
      const value = await readJson(taskFile)
      return value?.rounds.length === 2 && value.status === 'running'
    })
    await waitFor(() => agent.openTurn === 2)
    agent.finish()
    const completed = await waitFor(async () => {
      const value = await readJson(taskFile)
      return value?.status === 'completed' && value.rounds[1]?.outputPath ? value : null
    })
    const output = await readJson(completed.rounds[1].outputPath)
    assert.equal(output.sessionId, first.session.id)
    assert.equal(output.turnEnd.reason.kind, 'completed')
  } finally {
    await runtime1.shutdown().catch(() => {})
    await runtime2?.shutdown().catch(() => {})
    await removeOwnedTemp(root)
  }
})

test('the Agent pre-step guard rejects a UI-wide permission before the next model step', async () => {
  const p = await preparedRuntime()
  try {
    await p.runtime.start()
    await p.runtime.dispatch(
      buildStartCommand({ taskId: 'task-1', owner: 'owner-thread-1', cwd: p.cwd, prompt: 'first task' }),
    )
    const task = await waitFor(async () => {
      const value = await readJson(p.taskFile)
      return value?.status === 'running' ? value : null
    })
    const agent = p.agents.get(task.session.id)
    const session = p.sessions.get(task.session.id)
    await waitFor(() => agent.openTurn === 1)
    const next = () => ({ kind: 'enter', messages: [] })
    const signal = new AbortController().signal

    session.permissionPreset = 'danger-full-access'
    assert.deepEqual(await agent.ctx.runPreStep({ agent, step: 2, signal }, next), { kind: 'reject' })

    session.permissionPreset = 'workspace-write'
    assert.deepEqual(await agent.ctx.runPreStep({ agent, step: 3, signal }, next), {
      kind: 'enter',
      messages: [],
    })

    agent.finish()
    const failed = await waitFor(async () => {
      const value = await readJson(p.taskFile)
      return value?.status === 'failed' && value.rounds[0]?.outputPath ? value : null
    })
    assert.match(failed.lastError, /permission blocked before model step 2/)
    const output = await readJson(failed.rounds[0].outputPath)
    assert.equal(output.status, 'failed')
    assert.equal(output.turnEnd.reason.kind, 'completed', 'a later idle/complete turn cannot override the blocked round')
  } finally {
    await p.runtime.shutdown()
    await removeOwnedTemp(p.root)
  }
})

test('cancel during delayed prompt admission stops the Agent and clears the later queue', async () => {
  let releaseAdmission
  const admissionGate = new Promise((resolve) => {
    releaseAdmission = resolve
  })
  let markAdmissionStarted
  const admissionStarted = new Promise((resolve) => {
    markAdmissionStarted = resolve
  })
  const p = await preparedRuntime({
    promptGate: async () => {
      markAdmissionStarted()
      await admissionGate
    },
  })
  try {
    await p.runtime.start()
    await p.runtime.dispatch(
      buildStartCommand({ taskId: 'task-1', owner: 'owner-thread-1', cwd: p.cwd, prompt: 'first task' }),
    )
    await admissionStarted
    const task = await readJson(p.taskFile)
    assert.equal(task.status, 'running')
    const agent = p.agents.get(task.session.id)

    await p.runtime.dispatch(
      buildCancelCommand({ taskId: 'task-1', owner: 'owner-thread-1', reason: 'stop during admission' }),
    )
    assert.equal((await readJson(p.taskFile)).status, 'cancelled')

    releaseAdmission()
    const eventFile = path.join(p.layout.events, 'task-1.jsonl')
    await waitFor(async () => {
      try {
        return (await fs.readFile(eventFile, 'utf8')).includes('prompt-discarded')
      } catch {
        return false
      }
    })
    const after = await readJson(p.taskFile)
    assert.equal(after.status, 'cancelled')
    assert.equal(agent.inbox.length, 0, 'the late prompt was cleared from the inbox')
    assert.ok(agent.cancelCalls.length >= 2, 'cancel ran both at command time and after late admission')
    for (const call of agent.cancelCalls) assert.equal(call.options, undefined)
  } finally {
    await p.runtime.shutdown()
    await removeOwnedTemp(p.root)
  }
})

test('cold resume installs the guard on its own Agent and never on another session', async () => {
  const p = await preparedRuntime()
  try {
    await p.runtime.start()
    await p.runtime.dispatch(
      buildStartCommand({ taskId: 'task-1', owner: 'owner-thread-1', cwd: p.cwd, prompt: 'first task' }),
    )
    const first = await waitFor(async () => {
      const value = await readJson(p.taskFile)
      return value?.status === 'running' ? value : null
    })
    const sessionId = first.session.id
    await waitFor(() => p.agents.get(sessionId)?.inbox.length === 1)
    p.agents.get(sessionId).finish()
    await waitFor(async () => (await readJson(p.taskFile))?.status === 'completed')
    p.agents.delete(sessionId)

    // Match Cordis: accessing a service outside its inject scope throws.
    Object.defineProperty(p.ctx, 'shell', { get() { throw new Error('cannot get property "shell" without inject') } })
    Object.defineProperty(p.ctx, 'approval', { get() { throw new Error('cannot get property "approval" without inject') } })

    await p.runtime.dispatch(
      buildContinueCommand({ taskId: 'task-1', owner: 'owner-thread-1', prompt: 'cold second round' }),
    )
    await waitFor(async () => {
      const value = await readJson(p.taskFile)
      return value?.rounds.length === 2 && value.status === 'running'
    })
    const resumed = await waitFor(() => p.agents.get(sessionId))
    assert.equal(resumed.ctx.preStep.length, 1, 'resumed Agent has a pre-step guard')
    assert.equal(resumed.ctx.approval.length, 1, 'resumed Agent has its approval listener')
    assert.deepEqual(resumed.ctx.preStepOptions, { prepend: true })

    const foreignSession = makeSession('human-session', p.cwd)
    p.sessions.set(foreignSession.id, foreignSession)
    const foreign = new FakeAgent(foreignSession)
    p.agents.set(foreign.id, foreign)
    await p.ctx.emit('agent/created', { agent: foreign, source: 'resume' })
    assert.equal(foreign.ctx.preStep.length, 0, 'foreign Agent got no pre-step guard')
    assert.equal(foreign.ctx.approval.length, 0, 'foreign Agent got no approval listener')

    await p.runtime.dispatch(
      buildCancelCommand({ taskId: 'task-1', owner: 'owner-thread-1', reason: 'finished test' }),
    )
  } finally {
    await p.runtime.shutdown()
    await removeOwnedTemp(p.root)
  }
})

test('a cold resume that widens permission is failed closed on the real Agent', async () => {
  let coldSession = null
  let releaseResume
  const resumeGate = new Promise((resolve) => {
    releaseResume = resolve
  })
  let markResumeStarted
  const resumeStarted = new Promise((resolve) => {
    markResumeStarted = resolve
  })
  const p = await preparedRuntime({
    promptGate: async (request) => {
      if (!coldSession || request.sessionId !== coldSession.id) return
      coldSession.permissionPreset = 'danger-full-access'
      markResumeStarted()
      await resumeGate
    },
  })
  try {
    await p.runtime.start()
    await p.runtime.dispatch(
      buildStartCommand({ taskId: 'task-1', owner: 'owner-thread-1', cwd: p.cwd, prompt: 'first task' }),
    )
    const first = await waitFor(async () => {
      const value = await readJson(p.taskFile)
      return value?.status === 'running' ? value : null
    })
    const sessionId = first.session.id
    await waitFor(() => p.agents.get(sessionId)?.inbox.length === 1)
    p.agents.get(sessionId).finish()
    await waitFor(async () => (await readJson(p.taskFile))?.status === 'completed')
    p.agents.delete(sessionId)
    coldSession = p.sessions.get(sessionId)

    await p.runtime.dispatch(
      buildContinueCommand({ taskId: 'task-1', owner: 'owner-thread-1', prompt: 'cold second round' }),
    )
    await resumeStarted
    releaseResume()
    const failed = await waitFor(async () => {
      const value = await readJson(p.taskFile)
      return value?.status === 'failed' ? value : null
    })
    assert.match(failed.lastError, /live permission is danger-full-access, not workspace-write\/ask/)
    assert.equal(p.agents.get(sessionId)?.ctx.preStep.length ?? 0, 0, 'no guard was installed on a wider Agent')
  } finally {
    await p.runtime.shutdown()
    await removeOwnedTemp(p.root)
  }
})

test('cold permission refuses missing durable knobs without reading root services', async () => {
  for (const events of [[], [{ type: 'sandbox/mode', data: { mode: 'workspace-write' } }], [{ type: 'approval/policy', data: { policy: 'ask' } }]]) {
    const ctx = { sessionQuery: { async observeSession() { return { header: { id: 'cold', cwd: process.cwd() }, events } } } }
    for (const name of ['shell', 'approval']) Object.defineProperty(ctx, name, { get() { throw new Error('unexpected root service access') } })
    await assert.rejects(DelegationRuntime.prototype.assertColdPermission.call({ ctx }, { session: { id: 'cold' } }), /refusing cold continue: durable permission/)
  }
})
