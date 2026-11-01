#!/usr/bin/env node
// Local control end for the native Host plugin. It only writes command,
// decision, and review files under the configured project control directory;
// it never talks to the Desktop process directly and never edits a Session log.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  atomicWriteJson,
  controlLayout,
  ensureLayout,
  hostIsFresh,
  listJson,
  newId,
  readJson,
  safeId,
} from '../plugin/lib/store.mjs'
import {
  buildCancelCommand,
  buildContinueCommand,
  buildDecision,
  buildReview,
  buildStartCommand,
  commandFileName,
  validateDecision,
  VERDICTS,
} from '../plugin/lib/commands.mjs'
import {
  ACTIVE_STATUSES,
  isReviewAllowed,
  reviewView,
  summarizeTask,
} from '../plugin/lib/tasks.mjs'
import { validateOwner } from '../plugin/lib/policy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(here)
const DEFAULT_CONTROL_DIR = path.join(repoRoot, 'control')

class CliError extends Error {
  constructor(message, code = 2) {
    super(message)
    this.code = code
  }
}

const BOOLEAN_FLAGS = new Set(['json', 'help', 'force'])

function parseArgs(argv) {
  const command = argv[0] ?? 'help'
  const rest = argv.slice(1)
  const options = { _: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--') {
      options._.push(...rest.slice(index + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 0) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1)
        continue
      }
      const key = arg.slice(2)
      const next = rest[index + 1]
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('--')) {
        options[key] = true
      } else {
        options[key] = next
        index += 1
      }
      continue
    }
    options._.push(arg)
  }
  return { command, options }
}

function controlDirOf(options) {
  const raw = options['control-dir'] ?? process.env.DSH_CODEX_CONTROL_DIR ?? DEFAULT_CONTROL_DIR
  if (typeof raw !== 'string' || raw.trim() === '') throw new CliError('--control-dir must be a path')
  return path.resolve(raw)
}

function jsonFlag(options) {
  return options.json === true || options.json === 'true'
}

function requireOwner(options) {
  const raw = options.owner ?? process.env.DSH_CODEX_OWNER
  if (raw === undefined) {
    throw new CliError(
      '--owner is required: pass the calling Codex thread/task id (or set DSH_CODEX_OWNER). ' +
        'It is a local collaboration correlation, not an authentication claim.',
    )
  }
  try {
    return validateOwner(raw)
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }
}

function output(value, options, human) {
  if (jsonFlag(options)) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  } else {
    process.stdout.write(`${human(value)}\n`)
  }
}

async function readPrompt(options) {
  if (typeof options['task-file'] === 'string' && typeof options.prompt === 'string') {
    throw new CliError('use either --task-file or --prompt, not both')
  }
  if (typeof options['task-file'] === 'string') {
    const file = path.resolve(options['task-file'])
    const text = await fs.readFile(file, 'utf8')
    if (text.trim() === '') throw new CliError(`task file is empty: ${file}`)
    return { text, source: file }
  }
  if (typeof options.prompt === 'string') {
    if (options.prompt.trim() === '') throw new CliError('--prompt is empty')
    return { text: options.prompt, source: 'inline' }
  }
  throw new CliError('provide --task-file <utf8 path> or --prompt <text>')
}

async function writeCommand(controlDir, command) {
  const layout = await ensureLayout(controlDir)
  const file = path.join(layout.commands, commandFileName(command))
  await atomicWriteJson(file, command, { exclusive: true })
  return { file, layout }
}

async function hostView(controlDir) {
  const layout = controlLayout(controlDir)
  const host = await readJson(layout.host).catch(() => null)
  return {
    host,
    live: hostIsFresh(host),
    heartbeatAgeMs:
      host && typeof host.updatedAt === 'string' && Number.isFinite(Date.parse(host.updatedAt))
        ? Date.now() - Date.parse(host.updatedAt)
        : null,
  }
}

async function readTaskOrQueued(controlDir, taskId) {
  safeId(taskId, 'taskId')
  const layout = controlLayout(controlDir)
  const task = await readJson(path.join(layout.tasks, `${taskId}.json`))
  if (task) return { task, queued: null }
  const commands = await listJson(layout.commands)
  const queued = commands
    .map((item) => item.value)
    .filter((value) => value && value.taskId === taskId && value.kind === 'start')
    .at(-1) ?? null
  return { task: null, queued }
}

async function readReview(controlDir, taskId) {
  const layout = controlLayout(controlDir)
  return await readJson(path.join(layout.reviews, `${taskId}.json`))
}

async function commandStart(options) {
  const controlDir = controlDirOf(options)
  const owner = requireOwner(options)
  if (typeof options.cwd !== 'string' || options.cwd.trim() === '') {
    throw new CliError('--cwd is required: every delegated task needs its own existing project directory')
  }
  const { text, source } = await readPrompt(options)
  const taskId = typeof options['task-id'] === 'string' ? options['task-id'] : newId('task')
  let command
  try {
    command = buildStartCommand({
      taskId,
      title: typeof options.title === 'string' ? options.title : undefined,
      prompt: text,
      owner,
      cwd: options.cwd,
    })
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }
  const { file } = await writeCommand(controlDir, command)
  const value = {
    queued: true,
    taskId,
    commandId: command.commandId,
    owner,
    cwd: command.cwd,
    commandFile: file,
    controlDir,
    promptSource: source,
    note: 'This command is queued. The native Host plugin must be active to create the session.',
  }
  output(value, options, (v) =>
    [
      `queued task ${v.taskId} for owner ${v.owner}`,
      `cwd: ${v.cwd}`,
      `command: ${v.commandId}`,
      `control: ${v.controlDir}`,
      'The native Host plugin must be active; use "status" to follow it.',
    ].join('\n'),
  )
  return 0
}

async function commandContinue(options) {
  const controlDir = controlDirOf(options)
  const owner = requireOwner(options)
  const taskId = options._[0] ?? options.task
  if (typeof taskId !== 'string') throw new CliError('usage: continue <taskId> --owner <id> --task-file <path>')
  const { task } = await readTaskOrQueued(controlDir, taskId)
  if (!task) throw new CliError(`task ${taskId} does not exist yet`, 3)
  if (task.owner !== owner) throw new CliError(`owner mismatch: task ${taskId} belongs to ${task.owner}`, 3)
  if (ACTIVE_STATUSES.includes(task.status)) {
    throw new CliError(`task ${taskId} is ${task.status}; wait or cancel before starting another round`, 3)
  }
  const { text } = await readPrompt(options)
  const command = buildContinueCommand({ taskId, prompt: text, owner })
  const { file } = await writeCommand(controlDir, command)
  output(
    { queued: true, taskId, owner, commandId: command.commandId, commandFile: file, round: task.rounds.length + 1 },
    options,
    (v) => `queued round ${v.round} for ${v.taskId} (owner ${v.owner})`,
  )
  return 0
}

async function commandCancel(options) {
  const controlDir = controlDirOf(options)
  const owner = requireOwner(options)
  const taskId = options._[0] ?? options.task
  if (typeof taskId !== 'string') throw new CliError('usage: cancel <taskId> --owner <id> [--reason text]')
  const { task } = await readTaskOrQueued(controlDir, taskId)
  if (!task) throw new CliError(`task ${taskId} does not exist yet`, 3)
  if (task.owner !== owner) throw new CliError(`owner mismatch: task ${taskId} belongs to ${task.owner}`, 3)
  if (!ACTIVE_STATUSES.includes(task.status)) {
    throw new CliError(`task ${taskId} is already ${task.status}`, 3)
  }
  const command = buildCancelCommand({
    taskId,
    owner,
    reason: typeof options.reason === 'string' ? options.reason : 'cancelled by Codex CLI',
  })
  const { file } = await writeCommand(controlDir, command)
  output(
    { queued: true, taskId, owner, commandId: command.commandId, commandFile: file },
    options,
    (v) => `queued cancel for ${v.taskId} (owner ${v.owner})`,
  )
  return 0
}

async function taskView(controlDir, taskId) {
  const { task, queued } = await readTaskOrQueued(controlDir, taskId)
  if (!task) return { taskId, queued, task: null, review: null, reviewStale: false }
  const review = await readReview(controlDir, taskId)
  const viewed = reviewView(task, review)
  return {
    taskId,
    queued: null,
    task,
    summary: summarizeTask(task, review),
    review: viewed.review,
    reviewStale: viewed.stale,
  }
}

async function commandStatus(options) {
  const controlDir = controlDirOf(options)
  const host = await hostView(controlDir)
  const taskId = options._[0] ?? options.task
  if (typeof taskId === 'string') {
    const value = { host, ...(await taskView(controlDir, taskId)) }
    output(value, options, (v) => renderTask(v, controlDir))
    return 0
  }
  const layout = controlLayout(controlDir)
  const tasks = await listJson(layout.tasks)
  const summaries = []
  for (const item of tasks) {
    if (!item.value) continue
    summaries.push(summarizeTask(item.value, await readReview(controlDir, item.value.taskId)))
  }
  const commands = await listJson(layout.commands)
  const queued = commands
    .map((item) => item.value)
    .filter((value) => value && value.kind === 'start' && !tasks.some((task) => task.value?.taskId === value.taskId))
    .map((value) => ({ taskId: value.taskId, commandId: value.commandId, createdAt: value.createdAt }))
  const value = { host, tasks: summaries, queued }
  output(value, options, renderAll)
  return 0
}

async function commandPending(options) {
  const controlDir = controlDirOf(options)
  const layout = controlLayout(controlDir)
  const host = await hostView(controlDir)
  const items = (await listJson(layout.approvals))
    .map((item) => item.value)
    .filter((record) => record && record.state === 'pending')
    .map((record) => ({
      ...record,
      expired: typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) <= Date.now() : false,
    }))
  const value = { host, pending: items }
  output(value, options, (v) => {
    if (v.pending.length === 0) return `no pending approvals (host ${v.host.live ? 'live' : 'not live'})`
    return v.pending.map(renderApproval).join('\n\n')
  })
  return 0
}

function renderApproval(record) {
  const toolCall = record.operation?.toolCall
  const lines = [
    `request ${record.requestId}${record.expired ? ' [EXPIRED]' : ''}`,
    `  owner: ${record.owner}`,
    `  task: ${record.taskId} round ${record.round}`,
    `  tool: ${record.toolName}${record.callId ? ` callId=${record.callId}` : ''}`,
    `  operation source: ${record.operation?.source ?? 'unknown'}`,
    `  expires: ${record.expiresAt}`,
  ]
  if (record.reason) lines.push(`  reason: ${record.reason}`)
  if (toolCall) {
    lines.push(`  arguments:`)
    lines.push(
      JSON.stringify(toolCall.arguments, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    )
  } else {
    lines.push('  arguments: MISSING — this request cannot be approved')
  }
  lines.push(
    `  approve: codex-delegate approve ${record.requestId} --owner "${record.owner}"`,
    `  reject:  codex-delegate reject ${record.requestId} --owner "${record.owner}" --reason "..."`,
  )
  return lines.join('\n')
}

function renderTask(value, controlDir) {
  const lines = []
  lines.push(`host: ${value.host.live ? 'live' : 'not live'}${value.host.host?.state ? ` (${value.host.host.state})` : ''}`)
  if (!value.task) {
    lines.push(`task: ${value.taskId} not created yet`)
    if (value.queued) lines.push(`queued start command: ${value.queued.commandId} at ${value.queued.createdAt}`)
    return lines.join('\n')
  }
  const task = value.task
  lines.push(`task: ${task.taskId} — ${task.title}`)
  lines.push(`owner: ${task.owner}`)
  lines.push(`status: ${task.status}`)
  lines.push(`execution: ${task.execution.state} (round ${task.execution.lastRound}, basis ${task.execution.completionBasis ?? 'n/a'})`)
  lines.push(`session: ${task.session?.id ?? 'none'}`)
  lines.push(`workspace: ${task.workspace?.path ?? 'none'} (${task.workspace?.id ?? 'no id'})`)
  lines.push(`agent preset: ${task.session?.agentPreset ?? 'none'}`)
  lines.push(`permission: ${task.session?.permission ? `${task.session.permission.sandbox} + ${task.session.permission.approval}` : 'none'}`)
  lines.push(`rounds: ${task.rounds.length}; pending approvals: ${task.pendingApprovals}`)
  if (task.lastError) lines.push(`last error: ${task.lastError}`)
  if (value.review) {
    lines.push(`review: ${value.review.verdict}${value.reviewStale ? ' [STALE]' : ''} at ${value.review.reviewedAt}`)
    lines.push(`review evidence: ${value.review.evidence}`)
  } else {
    lines.push('review: none (execution completion is not acceptance)')
  }
  return lines.join('\n')
}

function renderAll(value) {
  const lines = [`host: ${value.host.live ? 'live' : 'not live'}${value.host.host?.state ? ` (${value.host.host.state})` : ''}`]
  if (value.tasks.length === 0) lines.push('no tasks')
  for (const task of value.tasks) {
    lines.push(
      `${task.taskId}  ${task.status.padEnd(18)} owner=${task.owner} cwd=${task.cwd ?? '-'} rounds=${task.rounds} pending=${task.pendingApprovals} review=${task.review ? (task.reviewStale ? 'stale' : task.review.verdict) : '-'}`,
    )
  }
  if (value.queued.length > 0) {
    lines.push('queued start commands (host has not created these tasks):')
    for (const item of value.queued) lines.push(`  ${item.taskId} (${item.commandId})`)
  }
  return lines.join('\n')
}

async function commandDecide(options, decision) {
  const controlDir = controlDirOf(options)
  const owner = requireOwner(options)
  const requestId = options._[0] ?? options.request
  if (typeof requestId !== 'string') {
    throw new CliError(`usage: ${decision} <requestId> --owner <id>${decision === 'reject' ? ' --reason text' : ''}`)
  }
  safeId(requestId, 'requestId')
  const layout = await ensureLayout(controlDir)
  const pendingFile = path.join(layout.approvals, `${requestId}.json`)
  const record = await readJson(pendingFile)
  if (!record || record.state !== 'pending') throw new CliError(`approval ${requestId} is not pending`, 3)
  if (record.owner !== owner) throw new CliError(`owner mismatch: approval ${requestId} belongs to ${record.owner}`, 3)
  if (typeof record.expiresAt === 'string' && Date.parse(record.expiresAt) <= Date.now()) {
    throw new CliError(`approval ${requestId} has expired; the Host will fail it closed`, 3)
  }
  if (!record.operation?.toolCall) {
    throw new CliError(`approval ${requestId} carries no complete tool call; it must not be approved`, 3)
  }
  const reason = typeof options.reason === 'string' ? options.reason : undefined
  if (decision === 'reject' && (reason === undefined || reason.trim() === '')) {
    throw new CliError('reject requires --reason so the audit records why')
  }
  const recordDecision = buildDecision({ requestId, decision, owner, reason })
  const valid = validateDecision(recordDecision, requestId, owner)
  if (!valid.ok) throw new CliError(`internal decision validation failed: ${valid.reason}`)
  const decisionFile = path.join(layout.decisions, `${requestId}.json`)
  const existing = await readJson(decisionFile)
  if (existing !== null) throw new CliError(`a decision already exists for ${requestId}`, 3)
  await atomicWriteJson(decisionFile, recordDecision, { exclusive: true })
  const value = {
    decided: true,
    requestId,
    owner,
    decision,
    decisionFile,
    taskId: record.taskId,
    note: 'one-shot decision written; the Host consumes it exactly once',
  }
  output(value, options, (v) => `${v.decision} written for ${v.requestId} (task ${v.taskId}, owner ${v.owner})`)
  return 0
}

async function commandReview(options) {
  const controlDir = controlDirOf(options)
  const owner = requireOwner(options)
  const taskId = options._[0] ?? options.task
  if (typeof taskId !== 'string') {
    throw new CliError('usage: review <taskId> --owner <id> --verdict accepted|rejected --evidence text')
  }
  const verdict = options.verdict
  if (!VERDICTS.includes(verdict)) throw new CliError(`--verdict must be one of ${VERDICTS.join(', ')}`)
  const evidence = options.evidence
  if (typeof evidence !== 'string' || evidence.trim() === '') throw new CliError('--evidence is required')
  const layout = await ensureLayout(controlDir)
  const task = await readJson(path.join(layout.tasks, `${taskId}.json`))
  if (!task) throw new CliError(`task ${taskId} does not exist`, 3)
  if (task.owner !== owner) throw new CliError(`owner mismatch: task ${taskId} belongs to ${task.owner}`, 3)
  if (!task.session?.id) throw new CliError(`task ${taskId} has no session to review`, 3)
  if (!isReviewAllowed(task)) throw new CliError(`task ${taskId} is ${task.status}; review is only possible after execution ends`, 3)
  const review = buildReview({
    taskId,
    round: task.rounds.length,
    sessionId: task.session.id,
    owner,
    executionState: task.execution.state,
    verdict,
    evidence,
  })
  const reviewFile = path.join(layout.reviews, `${taskId}.json`)
  const previous = await readJson(reviewFile)
  await atomicWriteJson(reviewFile, review)
  output(
    { recorded: true, review, reviewFile, replaced: previous !== null },
    options,
    (v) => `review ${v.review.verdict} recorded for ${taskId} (round ${v.review.round})`,
  )
  return 0
}

async function commandDoctor(options) {
  const controlDir = controlDirOf(options)
  const layout = await ensureLayout(controlDir)
  const host = await hostView(controlDir)
  const probe = path.join(layout.root, `.doctor-${newId('probe')}.tmp`)
  let writable = true
  let writeError = null
  try {
    await fs.writeFile(probe, 'probe', { encoding: 'utf8', flag: 'wx' })
    await fs.rm(probe, { force: true })
  } catch (error) {
    writable = false
    writeError = error instanceof Error ? error.message : String(error)
  }
  const tasks = await listJson(layout.tasks)
  const pending = (await listJson(layout.approvals)).filter((item) => item.value?.state === 'pending')
  const reviews = await listJson(layout.reviews)
  const value = {
    controlDir,
    controlDirWritable: writable,
    writeError,
    host: host.host,
    hostLive: host.live,
    heartbeatAgeMs: host.heartbeatAgeMs,
    missingServices: host.host?.missingServices ?? null,
    tasks: tasks.length,
    pendingApprovals: pending.length,
    reviews: reviews.length,
    note: host.live
      ? 'Host plugin heartbeat is fresh'
      : 'No fresh Host plugin heartbeat. Queued commands remain on disk; installing/enabling the plugin is required.',
  }
  output(value, options, (v) =>
    [
      `control: ${v.controlDir} (${v.controlDirWritable ? 'writable' : `NOT writable: ${v.writeError}`})`,
      `host: ${v.hostLive ? 'live' : 'not live'}${v.host?.state ? ` (${v.host.state})` : ''}`,
      `missing services: ${v.missingServices ? v.missingServices.join(', ') || 'none' : 'unknown (no host file)'}`,
      `tasks: ${v.tasks}; pending approvals: ${v.pendingApprovals}; reviews: ${v.reviews}`,
      v.note,
    ].join('\n'),
  )
  return 0
}

function helpText() {
  return `codex-delegate — local control end for the native Codex delegation Host plugin

Usage:
  codex-delegate start --owner <id> --cwd <existing project dir> --task-file <utf8> [--title text] [--json]
  codex-delegate start --owner <id> --cwd <existing project dir> --prompt <text> [--title text]
  codex-delegate continue <taskId> --owner <id> --task-file <utf8> [--json]
  codex-delegate cancel <taskId> --owner <id> [--reason text]
  codex-delegate status [taskId] [--json]
  codex-delegate pending [--json]
  codex-delegate approve <requestId> --owner <id> [--json]
  codex-delegate reject <requestId> --owner <id> --reason text
  codex-delegate review <taskId> --owner <id> --verdict accepted|rejected --evidence text
  codex-delegate doctor [--json]
  codex-delegate help

Global options:
  --owner <id>           calling Codex thread/task id (or $DSH_CODEX_OWNER).
                         A local collaboration correlation, not authentication.
  --cwd <path>           existing allowedRoot subdirectory, resolved with realpath
  --control-dir <path>   default: <repo>/control or $DSH_CODEX_CONTROL_DIR

Review is a separate action from execution. A completed task has no review
until this CLI writes one; the plugin never accepts its own work.`
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv)
  try {
    switch (command) {
      case 'start':
        return await commandStart(options)
      case 'continue':
        return await commandContinue(options)
      case 'cancel':
        return await commandCancel(options)
      case 'status':
        return await commandStatus(options)
      case 'pending':
        return await commandPending(options)
      case 'approve':
        return await commandDecide(options, 'allow')
      case 'reject':
        return await commandDecide(options, 'reject')
      case 'review':
        return await commandReview(options)
      case 'doctor':
        return await commandDoctor(options)
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(`${helpText()}\n`)
        return 0
      default:
        throw new CliError(`unknown command "${command}"\n\n${helpText()}`)
    }
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`error: ${error.message}\n`)
      return error.code
    }
    process.stderr.write(`error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  })
}

export {
  commandCancel,
  commandContinue,
  commandDecide,
  commandDoctor,
  commandPending,
  commandReview,
  commandStart,
  commandStatus,
  controlDirOf,
  parseArgs,
}
