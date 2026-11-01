import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  assertCompleteToolCall,
  buildApprovalRecord,
  closeStaleApprovals,
  resolveApprovalFile,
  waitForDecision,
  writeApprovalRequest,
} from '../native/plugin/lib/approval-queue.mjs'
import { buildDecision } from '../native/plugin/lib/commands.mjs'
import {
  atomicWriteJson,
  controlLayout,
  ensureLayout,
  readJson,
} from '../native/plugin/lib/store.mjs'

async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-approval-'))
  await ensureLayout(dir)
  return dir
}

function toolCall(overrides = {}) {
  return {
    name: 'pwsh',
    callId: 'call-1',
    rootCallId: 'call-1',
    parentCallId: null,
    arguments: { command: 'node --test', cwd: path.join(os.tmpdir(), 'dsh-test-project') },
    ...overrides,
  }
}

function recordFor(controlDir, requestId = 'apr-test') {
  return buildApprovalRecord({
    requestId,
    task: {
      taskId: 'task-1',
      owner: 'thread-owner-1',
      session: { id: 'session-1' },
    },
    round: 1,
    req: {
      toolName: 'pwsh',
      callId: 'call-1',
      reason: 'run the test suite',
      displayReason: 'Run tests',
      agent: { id: 'session-1', session: { id: 'session-1' } },
    },
    toolCall: toolCall(),
    hostId: 'host-test',
    timeoutMs: 5000,
  })
}

test('the pending record contains the exact tool arguments and owner', async () => {
  const controlDir = await workspace()
  const requestId = 'apr-full'
  await writeApprovalRequest(controlDir, recordFor(controlDir, requestId))
  const layout = controlLayout(controlDir)
  const record = await readJson(path.join(layout.approvals, `${requestId}.json`))
  assert.equal(record.owner, 'thread-owner-1')
  assert.equal(record.operation.complete, true)
  assert.equal(record.operation.source, 'tools/execute:exec.arguments')
  assert.deepEqual(record.operation.toolCall.arguments, toolCall().arguments)
})

test('a request without captured arguments is never written', async () => {
  const controlDir = await workspace()
  const record = recordFor(controlDir, 'apr-no-args')
  record.operation.toolCall.arguments = undefined
  await assert.rejects(() => writeApprovalRequest(controlDir, record), /arguments are unavailable/)
  assert.throws(() => assertCompleteToolCall({ name: 'pwsh', callId: 'call-1' }), /arguments are unavailable/)
})

test('an allow decision is consumed once and returns allowed-once', async () => {
  const controlDir = await workspace()
  const requestId = 'apr-allow'
  await writeApprovalRequest(controlDir, recordFor(controlDir, requestId))
  const waiting = waitForDecision({
    controlDir,
    requestId,
    owner: 'thread-owner-1',
    timeoutMs: 2000,
    pollIntervalMs: 10,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const layout = controlLayout(controlDir)
  await atomicWriteJson(
    path.join(layout.decisions, `${requestId}.json`),
    buildDecision({ requestId, decision: 'allow', owner: 'thread-owner-1' }),
    { exclusive: true },
  )
  const result = await waiting
  assert.equal(result.outcome, 'allowed-once')
  assert.equal(await readJson(path.join(layout.decisions, `${requestId}.json`)), null)
  assert.ok((await fs.readdir(layout.decisionsConsumed)).some((name) => name.startsWith(requestId)))
})

test('a rejection carries its reason and returns rejected', async () => {
  const controlDir = await workspace()
  const requestId = 'apr-reject'
  await writeApprovalRequest(controlDir, recordFor(controlDir, requestId))
  const waiting = waitForDecision({
    controlDir,
    requestId,
    owner: 'thread-owner-1',
    timeoutMs: 2000,
    pollIntervalMs: 10,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const layout = controlLayout(controlDir)
  await atomicWriteJson(
    path.join(layout.decisions, `${requestId}.json`),
    buildDecision({ requestId, decision: 'reject', owner: 'thread-owner-1', reason: 'not authorized for this path' }),
    { exclusive: true },
  )
  const result = await waiting
  assert.equal(result.outcome, 'rejected')
  assert.match(result.reason, /not authorized/)
})

test('a decision from another owner fails closed', async () => {
  const controlDir = await workspace()
  const requestId = 'apr-owner'
  await writeApprovalRequest(controlDir, recordFor(controlDir, requestId))
  const waiting = waitForDecision({
    controlDir,
    requestId,
    owner: 'thread-owner-1',
    timeoutMs: 2000,
    pollIntervalMs: 10,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const layout = controlLayout(controlDir)
  await atomicWriteJson(
    path.join(layout.decisions, `${requestId}.json`),
    buildDecision({ requestId, decision: 'allow', owner: 'other-thread' }),
    { exclusive: true },
  )
  const result = await waiting
  assert.equal(result.outcome, 'rejected')
  assert.match(result.reason, /owner does not match/)
  assert.ok((await fs.readdir(layout.decisionsInvalid)).length >= 1)
})

test('no decision fails closed at the timeout', async () => {
  const controlDir = await workspace()
  const requestId = 'apr-timeout'
  await writeApprovalRequest(controlDir, recordFor(controlDir, requestId))
  const result = await waitForDecision({
    controlDir,
    requestId,
    owner: 'thread-owner-1',
    timeoutMs: 60,
    pollIntervalMs: 10,
  })
  assert.equal(result.outcome, 'rejected')
  assert.match(result.reason, /timeout/)
})

test('a late decision after a timeout cannot grant and a duplicate waiter is refused', async () => {
  const controlDir = await workspace()
  const requestId = 'apr-late'
  await writeApprovalRequest(controlDir, recordFor(controlDir, requestId))
  const timedOut = await waitForDecision({
    controlDir,
    requestId,
    owner: 'thread-owner-1',
    timeoutMs: 30,
    pollIntervalMs: 10,
  })
  assert.equal(timedOut.outcome, 'rejected')
  await resolveApprovalFile({ controlDir, requestId, outcome: 'rejected', reason: 'timeout' })
  const layout = controlLayout(controlDir)
  await atomicWriteJson(
    path.join(layout.decisions, `${requestId}.json`),
    buildDecision({ requestId, decision: 'allow', owner: 'thread-owner-1' }),
  )
  const duplicate = await waitForDecision({
    controlDir,
    requestId,
    owner: 'thread-owner-1',
    timeoutMs: 100,
    pollIntervalMs: 10,
  })
  assert.equal(duplicate.outcome, 'rejected')
  assert.match(duplicate.reason, /already resolved/)
})

test('an invalid or mismatched decision fails closed and is quarantined', async () => {
  const controlDir = await workspace()
  const requestId = 'apr-invalid'
  await writeApprovalRequest(controlDir, recordFor(controlDir, requestId))
  const waiting = waitForDecision({
    controlDir,
    requestId,
    owner: 'thread-owner-1',
    timeoutMs: 2000,
    pollIntervalMs: 10,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const layout = controlLayout(controlDir)
  await atomicWriteJson(path.join(layout.decisions, `${requestId}.json`), {
    schema: 1,
    requestId,
    decision: 'allow-always',
    owner: 'thread-owner-1',
    decidedAt: new Date().toISOString(),
  })
  const result = await waiting
  assert.equal(result.outcome, 'rejected')
  assert.match(result.reason, /invalid decision/)
  assert.ok((await fs.readdir(layout.decisionsInvalid)).length >= 1)
})

test('aborting the approval signal returns cancelled', async () => {
  const controlDir = await workspace()
  const requestId = 'apr-abort'
  await writeApprovalRequest(controlDir, recordFor(controlDir, requestId))
  const controller = new AbortController()
  const waiting = waitForDecision({
    controlDir,
    requestId,
    owner: 'thread-owner-1',
    timeoutMs: 2000,
    pollIntervalMs: 10,
    signal: controller.signal,
  })
  controller.abort()
  const result = await waiting
  assert.equal(result.outcome, 'cancelled')
})

test('a pending request from another host is closed as interrupted, never approved', async () => {
  const controlDir = await workspace()
  const requestId = 'apr-stale'
  await writeApprovalRequest(controlDir, { ...recordFor(controlDir, requestId), hostId: 'old-host' })
  const closed = await closeStaleApprovals({ controlDir, hostId: 'new-host' })
  assert.equal(closed.length, 1)
  assert.equal(closed[0].outcome, 'cancelled')
  assert.match(closed[0].decisionReason, /restarted/)
  const layout = controlLayout(controlDir)
  assert.equal(await readJson(path.join(layout.approvals, `${requestId}.json`)), null)
  const resolved = await readJson(path.join(layout.approvalsResolved, `${requestId}.json`))
  assert.equal(resolved.state, 'resolved')
  assert.equal(resolved.outcome, 'cancelled')
})

test('resolving a pending approval archives it without granting anything', async () => {
  const controlDir = await workspace()
  const requestId = 'apr-archive'
  await writeApprovalRequest(controlDir, recordFor(controlDir, requestId))
  const resolved = await resolveApprovalFile({
    controlDir,
    requestId,
    outcome: 'rejected',
    reason: 'archived by test',
  })
  assert.equal(resolved.outcome, 'rejected')
  const layout = controlLayout(controlDir)
  assert.equal(await readJson(path.join(layout.approvals, `${requestId}.json`)), null)
})
