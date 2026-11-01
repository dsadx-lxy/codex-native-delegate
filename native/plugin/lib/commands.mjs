// Wire records shared by the CLI, the Host runtime, and the offline tests.
// Every record is plain JSON; no function or class crosses the queue boundary.
// `owner` is a local collaboration correlation (the calling Codex thread/task
// id), not an authentication claim. Every follow-up command must carry the
// owner recorded on the task; the Host rejects a mismatch.

import path from 'node:path'
import { SCHEMA, newId, nowIso, safeId } from './store.mjs'
import { validateOwner } from './policy.mjs'

export const COMMAND_KINDS = Object.freeze(['start', 'continue', 'cancel'])
export const DECISIONS = Object.freeze(['allow', 'reject'])
export const VERDICTS = Object.freeze(['accepted', 'rejected'])

function requireText(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

export function buildStartCommand({ taskId = newId('task'), title, prompt, owner, cwd, requestedBy = 'codex-cli' } = {}) {
  safeId(taskId, 'taskId')
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new TypeError('cwd must be an absolute project directory')
  }
  return {
    schema: SCHEMA,
    commandId: newId('cmd'),
    kind: 'start',
    taskId,
    owner: validateOwner(owner),
    cwd: path.resolve(cwd),
    title: typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined,
    prompt: requireText(prompt, 'prompt'),
    requestedBy,
    createdAt: nowIso(),
  }
}

export function buildContinueCommand({ taskId, prompt, owner, requestedBy = 'codex-cli' } = {}) {
  safeId(taskId, 'taskId')
  return {
    schema: SCHEMA,
    commandId: newId('cmd'),
    kind: 'continue',
    taskId,
    owner: validateOwner(owner),
    prompt: requireText(prompt, 'prompt'),
    requestedBy,
    createdAt: nowIso(),
  }
}

export function buildCancelCommand({ taskId, owner, reason = 'cancelled by Codex CLI', requestedBy = 'codex-cli' } = {}) {
  safeId(taskId, 'taskId')
  return {
    schema: SCHEMA,
    commandId: newId('cmd'),
    kind: 'cancel',
    taskId,
    owner: validateOwner(owner),
    reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : 'cancelled by Codex CLI',
    requestedBy,
    createdAt: nowIso(),
  }
}

export function validateCommand(command) {
  if (!command || typeof command !== 'object') throw new TypeError('command must be an object')
  if (command.schema !== SCHEMA) throw new TypeError(`unsupported command schema ${String(command.schema)}`)
  safeId(command.commandId, 'commandId')
  safeId(command.taskId, 'taskId')
  if (!COMMAND_KINDS.includes(command.kind)) throw new TypeError(`unsupported command kind ${String(command.kind)}`)
  command.owner = validateOwner(command.owner)
  if (command.kind === 'start') {
    if (typeof command.cwd !== 'string' || !path.isAbsolute(command.cwd)) {
      throw new TypeError('start command cwd must be an absolute project directory')
    }
    requireText(command.prompt, 'prompt')
  }
  if (command.kind === 'continue') requireText(command.prompt, 'prompt')
  return command
}

export function commandFileName(command) {
  return `${String(Date.now()).padStart(13, '0')}-${command.commandId}.json`
}

export function buildDecision({ requestId, decision, owner, reason, decidedBy = 'codex-cli' } = {}) {
  safeId(requestId, 'requestId')
  if (!DECISIONS.includes(decision)) throw new TypeError(`decision must be one of ${DECISIONS.join(', ')}`)
  if (decision === 'reject') requireText(reason, 'rejection reason')
  return {
    schema: SCHEMA,
    requestId,
    decision,
    owner: validateOwner(owner),
    reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : undefined,
    decidedBy,
    decidedAt: nowIso(),
  }
}

export function validateDecision(decision, requestId, owner) {
  if (!decision || typeof decision !== 'object') return { ok: false, reason: 'decision is not an object' }
  if (decision.schema !== SCHEMA) return { ok: false, reason: `unsupported decision schema ${String(decision.schema)}` }
  if (decision.requestId !== requestId) return { ok: false, reason: 'decision requestId does not match the pending request' }
  if (owner !== undefined && decision.owner !== owner) {
    return { ok: false, reason: 'decision owner does not match the task owner' }
  }
  if (!DECISIONS.includes(decision.decision)) return { ok: false, reason: `invalid decision ${String(decision.decision)}` }
  if (decision.decision === 'reject' && (typeof decision.reason !== 'string' || decision.reason.trim() === '')) {
    return { ok: false, reason: 'a rejection must carry a reason' }
  }
  if (typeof decision.decidedAt !== 'string' || !Number.isFinite(Date.parse(decision.decidedAt))) {
    return { ok: false, reason: 'decision decidedAt is not a valid timestamp' }
  }
  return { ok: true }
}

export function buildReview({ taskId, round, sessionId, owner, executionState, verdict, evidence, reviewer = 'codex' } = {}) {
  safeId(taskId, 'taskId')
  if (!Number.isInteger(round) || round < 1) throw new TypeError('round must be a positive integer')
  safeId(sessionId, 'sessionId')
  if (!VERDICTS.includes(verdict)) throw new TypeError(`verdict must be one of ${VERDICTS.join(', ')}`)
  requireText(evidence, 'evidence')
  return {
    schema: SCHEMA,
    taskId,
    round,
    sessionId,
    owner: validateOwner(owner),
    executionState,
    verdict,
    evidence,
    reviewer,
    reviewedAt: nowIso(),
  }
}

export default {
  COMMAND_KINDS,
  DECISIONS,
  VERDICTS,
  buildCancelCommand,
  buildContinueCommand,
  buildDecision,
  buildReview,
  buildStartCommand,
  commandFileName,
  validateCommand,
  validateDecision,
}
