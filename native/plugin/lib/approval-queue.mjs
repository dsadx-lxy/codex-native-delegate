// One-shot approval queue. A request is a file in approvals/, a decision is a
// separate file in decisions/, and the Host consumes the decision exactly once
// before returning "allowed-once" to the approval waterfall. There is no
// allow-always path and no wildcard.
//
// A pending request is only written when the real `tools/execute` arguments
// for the asking callId were captured. If they are missing or inconsistent,
// the Host rejects immediately and never offers the request to the CLI.

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  SCHEMA,
  atomicWriteJson,
  controlLayout,
  listJson,
  moveInto,
  nowIso,
  readJson,
  safeId,
} from './store.mjs'
import { validateDecision } from './commands.mjs'

export function buildApprovalRecord({
  requestId,
  task,
  round,
  req,
  toolCall,
  hostId,
  timeoutMs,
  now = nowIso(),
}) {
  safeId(requestId, 'requestId')
  return {
    schema: SCHEMA,
    requestId,
    state: 'pending',
    hostId,
    taskId: task.taskId,
    owner: task.owner,
    round,
    sessionId: task.session.id,
    agentId: req?.agent?.id ?? task.session.id,
    toolName: toolCall.name,
    callId: toolCall.callId,
    rootCallId: toolCall.rootCallId,
    parentCallId: toolCall.parentCallId ?? null,
    reason: typeof req?.reason === 'string' ? req.reason : undefined,
    displayReason: typeof req?.displayReason === 'string' ? req.displayReason : undefined,
    operation: {
      complete: true,
      source: 'tools/execute:exec.arguments',
      toolCall,
    },
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + timeoutMs).toISOString(),
  }
}

export function assertCompleteToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') throw new Error('tool execution arguments were not captured')
  if (typeof toolCall.name !== 'string' || toolCall.name === '') throw new Error('tool execution name is missing')
  if (typeof toolCall.callId !== 'string' || toolCall.callId === '') throw new Error('tool execution callId is missing')
  if (!Object.hasOwn(toolCall, 'arguments') || toolCall.arguments === undefined) {
    throw new Error('tool execution arguments are unavailable')
  }
  return toolCall
}

export async function writeApprovalRequest(controlDir, record) {
  const layout = controlLayout(controlDir)
  assertCompleteToolCall(record.operation?.toolCall)
  const file = path.join(layout.approvals, `${safeId(record.requestId, 'requestId')}.json`)
  await atomicWriteJson(file, record, { exclusive: true })
  return file
}

async function consumeDecision(controlDir, requestId) {
  const layout = controlLayout(controlDir)
  const source = path.join(layout.decisions, `${requestId}.json`)
  const target = path.join(layout.decisionsConsumed, `${requestId}-${Date.now()}.json`)
  return await moveInto(source, path.dirname(target), path.basename(target))
}

function abortableSleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

export async function waitForDecision({
  controlDir,
  requestId,
  owner,
  timeoutMs,
  pollIntervalMs = 250,
  signal,
  isStopping,
}) {
  safeId(requestId, 'requestId')
  const layout = controlLayout(controlDir)
  const resolvedFile = path.join(layout.approvalsResolved, `${requestId}.json`)
  if ((await readJson(resolvedFile)) !== null) {
    return { outcome: 'rejected', reason: 'approval was already resolved; refusing a duplicate waiter' }
  }
  const deadline = Date.now() + Math.max(1, timeoutMs)
  for (;;) {
    if (signal?.aborted) return { outcome: 'cancelled', reason: 'approval signal aborted' }
    if (typeof isStopping === 'function' && isStopping()) {
      return { outcome: 'cancelled', reason: 'Host plugin stopped while the approval was pending' }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { outcome: 'rejected', reason: 'approval decision timeout: no one-shot decision arrived' }
    }
    const decisionFile = path.join(layout.decisions, `${requestId}.json`)
    let decision = null
    try {
      decision = await readJson(decisionFile)
    } catch (error) {
      const invalidTarget = path.join(layout.decisionsInvalid, `${requestId}-${Date.now()}.json`)
      await moveInto(decisionFile, path.dirname(invalidTarget), path.basename(invalidTarget)).catch(() => {})
      return { outcome: 'rejected', reason: `invalid decision file: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (decision !== null) {
      const consumed = await consumeDecision(controlDir, requestId)
      if (consumed === null) {
        return { outcome: 'rejected', reason: 'decision vanished before it could be consumed; failing closed' }
      }
      const valid = validateDecision(decision, requestId, owner)
      if (!valid.ok) {
        await moveInto(consumed, layout.decisionsInvalid, `${requestId}-${Date.now()}.json`).catch(() => {})
        return { outcome: 'rejected', reason: `invalid decision: ${valid.reason}` }
      }
      if (decision.decision === 'allow') return { outcome: 'allowed-once', decision }
      return { outcome: 'rejected', decision, reason: decision.reason ?? 'rejected by Codex' }
    }
    await abortableSleep(Math.min(pollIntervalMs, Math.max(1, remaining)), signal)
  }
}

export async function resolveApprovalFile({ controlDir, requestId, outcome, reason = null, now = nowIso() }) {
  safeId(requestId, 'requestId')
  const layout = controlLayout(controlDir)
  const pendingFile = path.join(layout.approvals, `${requestId}.json`)
  const record = await readJson(pendingFile)
  if (record === null) return null
  const resolved = {
    ...record,
    state: 'resolved',
    outcome,
    decisionReason: reason,
    resolvedAt: now,
  }
  await atomicWriteJson(path.join(layout.approvalsResolved, `${requestId}.json`), resolved)
  await fs.rm(pendingFile, { force: true })
  if (outcome !== 'allowed-once') {
    // A decision that arrives after a timeout/cancel must not be consumable by
    // a later duplicate waiter. Quarantine it rather than deleting the audit.
    const late = path.join(layout.decisions, `${requestId}.json`)
    await moveInto(late, layout.decisionsInvalid, `${requestId}-late-${Date.now()}.json`).catch(() => {})
  }
  return resolved
}

/**
 * On Host startup, no waiter from the previous process exists. Any pending file
 * left by another hostId is therefore unresolvable and is closed as
 * "interrupted", never approved. Expired requests from the current host are
 * closed as "expired".
 */
export async function closeStaleApprovals({ controlDir, hostId, now = nowIso() }) {
  const layout = controlLayout(controlDir)
  const pending = await listJson(layout.approvals)
  const closed = []
  for (const item of pending) {
    const record = item.value
    if (!record || record.state !== 'pending') continue
    const foreign = typeof record.hostId === 'string' && record.hostId !== hostId
    const expired = typeof record.expiresAt === 'string' && Date.parse(record.expiresAt) <= Date.parse(now)
    if (!foreign && !expired) continue
    const outcome = foreign ? 'cancelled' : 'rejected'
    const reason = foreign
      ? 'Host plugin restarted while this approval was pending; no live waiter exists'
      : 'approval expired before a decision arrived'
    const resolved = await resolveApprovalFile({
      controlDir,
      requestId: record.requestId,
      outcome,
      reason,
      now,
    })
    if (resolved) closed.push(resolved)
  }
  return closed
}

export default {
  assertCompleteToolCall,
  buildApprovalRecord,
  closeStaleApprovals,
  resolveApprovalFile,
  waitForDecision,
  writeApprovalRequest,
}
