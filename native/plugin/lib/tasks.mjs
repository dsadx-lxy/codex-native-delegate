// Task state machine. The Host plugin is the only writer of task records; the
// CLI only writes commands, approval decisions, and independent review files.
// Keeping those writers apart is what makes execution completion and
// acceptance separate facts rather than one mutable status.

import { nowIso, shortHash } from './store.mjs'

export const TASK_SCHEMA = 1

export const TASK_STATUSES = Object.freeze([
  'creating',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'interrupted'])

export const ACTIVE_STATUSES = Object.freeze(['creating', 'running', 'awaiting_approval'])

export const ACTIVE_RUNNING_STATUSES = Object.freeze(['running', 'awaiting_approval'])

export function createTaskRecord({ taskId, title, prompt, commandId, owner, hostId, now = nowIso() }) {
  if (typeof taskId !== 'string' || taskId === '') throw new TypeError('taskId is required')
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new TypeError('prompt is required')
  if (typeof owner !== 'string' || owner.trim() === '') throw new TypeError('owner is required')
  return {
    schema: TASK_SCHEMA,
    taskId,
    title: title || `Codex 委派 · ${taskId.slice(-8)}`,
    owner,
    createdByCommandId: commandId,
    hostId,
    status: 'creating',
    execution: {
      state: 'pending',
      startedAt: null,
      endedAt: null,
      lastRound: 0,
      completionBasis: null,
    },
    session: null,
    workspace: null,
    rounds: [],
    approvals: [],
    pendingApprovals: 0,
    activeRound: null,
    cancelRequested: false,
    lastError: null,
    warnings: [],
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Create -> first round is one explicit transition. A record is born
 * `creating`; exactly one round may be begun from that state. Every other
 * begin, and every begin while an active round exists, is refused. This keeps
 * the initial admission from being confused with an ordinary continue while
 * still preventing two live rounds on one task.
 */
export function beginFirstRound(task, { commandId, prompt, now = nowIso() } = {}) {
  if (!task || typeof task !== 'object') throw new TypeError('task is required')
  if (task.status !== 'creating') {
    throw new Error(`task ${task.taskId} is ${task.status}, not creating; refusing a first round`)
  }
  if (task.activeRound !== null && task.activeRound !== undefined) {
    throw new Error(`task ${task.taskId} already has an active round ${task.activeRound}`)
  }
  if (task.rounds.length !== 0) {
    throw new Error(`task ${task.taskId} is creating but already has ${task.rounds.length} round(s)`)
  }
  return beginRound(task, { commandId, prompt, now, allowFrom: ['creating'] })
}

export function beginRound(task, { commandId, prompt, now = nowIso(), allowFrom = [] } = {}) {
  if (!task || typeof task !== 'object') throw new TypeError('task is required')
  if (ACTIVE_STATUSES.includes(task.status) && task.status !== 'creating' && !allowFrom.includes(task.status)) {
    throw new Error(`task ${task.taskId} is ${task.status}; wait for it to end or cancel it first`)
  }
  if (task.activeRound !== null && task.activeRound !== undefined) {
    throw new Error(`task ${task.taskId} already has an active round ${task.activeRound}; wait for it to end or cancel it first`)
  }
  if (task.status === 'creating' && task.rounds.length !== 0) {
    throw new Error(`task ${task.taskId} is creating but already has ${task.rounds.length} round(s); refusing a duplicate first round`)
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new TypeError('prompt is required')
  const round = task.rounds.length + 1
  task.rounds.push({
    round,
    commandId,
    prompt,
    promptChars: prompt.length,
    promptHash: shortHash(prompt),
    requestId: null,
    acceptedAt: null,
    endedAt: null,
    state: 'pending',
    approvalCount: 0,
    outputPath: null,
    outputStatus: null,
    outputCapturedAt: null,
  })
  task.activeRound = round
  task.cancelRequested = false
  task.status = 'running'
  task.execution.state = 'running'
  task.execution.startedAt ??= now
  task.execution.lastRound = round
  task.execution.endedAt = null
  task.execution.completionBasis = null
  task.lastError = null
  task.updatedAt = now
  return round
}

export function markRoundAccepted(task, round, { requestId, now = nowIso() }) {
  const record = task.rounds.find((item) => item.round === round)
  if (!record) throw new Error(`round ${round} does not exist on ${task.taskId}`)
  record.requestId = requestId
  record.acceptedAt = now
  record.state = 'running'
  task.updatedAt = now
}

export function markAwaiting(task, round, { requestId, now = nowIso() }) {
  task.pendingApprovals += 1
  task.status = 'awaiting_approval'
  task.execution.state = 'running'
  const record = task.rounds.find((item) => item.round === round)
  if (record) record.approvalCount += 1
  task.approvals.push({
    requestId,
    round,
    createdAt: now,
    resolvedAt: null,
    outcome: null,
    decisionReason: null,
  })
  task.updatedAt = now
}

export function markApprovalResolved(task, requestId, { outcome, reason = null, now = nowIso() }) {
  task.pendingApprovals = Math.max(0, task.pendingApprovals - 1)
  const approval = task.approvals.find((item) => item.requestId === requestId)
  if (approval) {
    approval.resolvedAt = now
    approval.outcome = outcome
    approval.decisionReason = reason
  }
  if (TERMINAL_STATUSES.includes(task.status)) {
    task.updatedAt = now
    return
  }
  task.status = task.pendingApprovals > 0 ? 'awaiting_approval' : 'running'
  task.updatedAt = now
}

export function markCompleted(task, round, { basis = 'agent-when-idle', now = nowIso() } = {}) {
  if (!task || task.cancelRequested || task.status === 'cancelled') return false
  if (!ACTIVE_RUNNING_STATUSES.includes(task.status)) return false
  if (task.execution.state !== 'running') return false
  if (task.activeRound !== round) return false
  const record = task.rounds.find((item) => item.round === round)
  if (record) {
    record.state = 'completed'
    record.endedAt = now
  }
  task.status = 'completed'
  task.execution.state = 'completed'
  task.execution.endedAt = now
  task.execution.completionBasis = basis
  task.activeRound = null
  task.pendingApprovals = 0
  task.updatedAt = now
  return true
}

export function markFailed(task, round, { error, now = nowIso() }) {
  if (!task || task.cancelRequested || task.status === 'cancelled') return false
  if (TERMINAL_STATUSES.includes(task.status)) return false
  if (round !== undefined && round !== null && task.activeRound !== round) return false
  const record = task.rounds.find((item) => item.round === round)
  if (record) {
    record.state = 'failed'
    record.endedAt = now
  }
  task.status = 'failed'
  task.execution.state = 'failed'
  task.execution.endedAt = now
  task.execution.completionBasis = 'error'
  task.activeRound = null
  task.lastError = error instanceof Error ? error.message : String(error)
  task.updatedAt = now
  return true
}

export function markCancelled(task, { now = nowIso(), reason = 'cancelled by Codex' } = {}) {
  task.cancelRequested = true
  if (TERMINAL_STATUSES.includes(task.status) && task.status !== 'interrupted') {
    task.updatedAt = now
    return false
  }
  const round = task.activeRound
  const record = task.rounds.find((item) => item.round === round)
  if (record) {
    record.state = 'cancelled'
    record.endedAt = now
  }
  task.status = 'cancelled'
  task.execution.state = 'cancelled'
  task.execution.endedAt = now
  task.execution.completionBasis = reason
  task.activeRound = null
  task.updatedAt = now
  return true
}

export function markInterrupted(task, { now = nowIso(), reason = 'Host plugin stopped during execution' } = {}) {
  if (!ACTIVE_STATUSES.includes(task.status)) return false
  const round = task.activeRound
  const record = task.rounds.find((item) => item.round === round)
  if (record) {
    record.state = 'interrupted'
    record.endedAt = now
  }
  task.status = 'interrupted'
  task.execution.state = 'interrupted'
  task.execution.endedAt = now
  task.execution.completionBasis = reason
  task.activeRound = null
  task.pendingApprovals = 0
  task.lastError = reason
  task.updatedAt = now
  return true
}

export function isReviewAllowed(task) {
  return TERMINAL_STATUSES.includes(task.status) && task.activeRound === null
}

export function reviewView(task, review) {
  if (!review) return { review: null, stale: false }
  const expectedRound = task.rounds.length
  const stale =
    review.round !== expectedRound ||
    review.sessionId !== task.session?.id ||
    review.owner !== task.owner ||
    (task.execution.endedAt !== null && Date.parse(review.reviewedAt) < Date.parse(task.execution.endedAt))
  return { review, stale }
}

export function summarizeTask(task, review) {
  const reviewed = reviewView(task, review)
  return {
    taskId: task.taskId,
    title: task.title,
    owner: task.owner,
    status: task.status,
    execution: task.execution,
    sessionId: task.session?.id ?? null,
    agentPreset: task.session?.agentPreset ?? null,
    permission: task.session?.permission ?? null,
    workspace: task.workspace,
    cwd: task.workspace?.path ?? null,
    rounds: task.rounds.length,
    roundOutputs: task.rounds.map((round) => ({
      round: round.round,
      state: round.state,
      requestId: round.requestId,
      outputPath: round.outputPath ?? null,
      outputStatus: round.outputStatus ?? null,
      outputCapturedAt: round.outputCapturedAt ?? null,
    })),
    pendingApprovals: task.pendingApprovals,
    review: reviewed.review,
    reviewStale: reviewed.stale,
    lastError: task.lastError,
    updatedAt: task.updatedAt,
  }
}

export default {
  ACTIVE_RUNNING_STATUSES,
  ACTIVE_STATUSES,
  TASK_SCHEMA,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  beginFirstRound,
  beginRound,
  createTaskRecord,
  isReviewAllowed,
  markApprovalResolved,
  markAwaiting,
  markCancelled,
  markCompleted,
  markFailed,
  markInterrupted,
  markRoundAccepted,
  reviewView,
  summarizeTask,
}
