import test from 'node:test'
import assert from 'node:assert/strict'

import {
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
} from '../native/plugin/lib/tasks.mjs'

const prompt = 'Implement the change and report evidence.'

function task() {
  return createTaskRecord({
    taskId: 'task-test',
    title: 'Test task',
    prompt,
    commandId: 'cmd-start',
    owner: 'owner-thread-1',
    hostId: 'host-1',
    now: '2026-01-01T00:00:00.000Z',
  })
}

test('execution completion does not create an acceptance review', () => {
  const current = task()
  const round = beginRound(current, { commandId: 'cmd-start', prompt, now: '2026-01-01T00:00:01.000Z' })
  markRoundAccepted(current, round, { requestId: 'rpc-1', now: '2026-01-01T00:00:02.000Z' })
  assert.equal(current.status, 'running')
  assert.equal(markCompleted(current, round, { now: '2026-01-01T00:00:03.000Z' }), true)
  assert.equal(current.status, 'completed')
  assert.equal(current.execution.state, 'completed')
  assert.equal(isReviewAllowed(current), true)
  assert.deepEqual(reviewView(current, null), { review: null, stale: false })
})

test('a review becomes stale after another round begins', () => {
  const current = task()
  current.session = { id: 'session-1' }
  const first = beginRound(current, { commandId: 'cmd-start', prompt, now: '2026-01-01T00:00:01.000Z' })
  markCompleted(current, first, { now: '2026-01-01T00:00:03.000Z' })
  const review = {
    schema: 1,
    taskId: current.taskId,
    round: 1,
    sessionId: 'session-1',
    owner: 'owner-thread-1',
    executionState: 'completed',
    verdict: 'accepted',
    evidence: 'reviewed',
    reviewer: 'codex',
    reviewedAt: '2026-01-01T00:00:04.000Z',
  }
  assert.equal(reviewView(current, review).stale, false)
  beginRound(current, { commandId: 'cmd-continue', prompt: 'next round', now: '2026-01-01T00:00:05.000Z' })
  const stale = reviewView(current, review)
  assert.equal(stale.review, review)
  assert.equal(stale.stale, true)
})

test('approval resolution returns the task to running while the round is active', () => {
  const current = task()
  current.session = { id: 'session-1' }
  const round = beginRound(current, { commandId: 'cmd-start', prompt, now: '2026-01-01T00:00:01.000Z' })
  markAwaiting(current, round, { requestId: 'apr-1', now: '2026-01-01T00:00:02.000Z' })
  assert.equal(current.status, 'awaiting_approval')
  assert.equal(current.pendingApprovals, 1)
  markApprovalResolved(current, 'apr-1', {
    outcome: 'allowed-once',
    reason: null,
    now: '2026-01-01T00:00:03.000Z',
  })
  assert.equal(current.status, 'running')
  assert.equal(current.pendingApprovals, 0)
  assert.equal(current.approvals[0].outcome, 'allowed-once')
})

test('cancellation wins over a later idle settlement', () => {
  const current = task()
  current.session = { id: 'session-1' }
  const round = beginRound(current, { commandId: 'cmd-start', prompt, now: '2026-01-01T00:00:01.000Z' })
  markCancelled(current, { now: '2026-01-01T00:00:02.000Z' })
  assert.equal(current.status, 'cancelled')
  assert.equal(markCompleted(current, round, { now: '2026-01-01T00:00:03.000Z' }), false)
  assert.equal(current.status, 'cancelled')
})

test('a failed round cannot be completed by a later idle settlement', () => {
  const current = task()
  current.session = { id: 'session-1' }
  const round = beginRound(current, { commandId: 'cmd-start', prompt, now: '2026-01-01T00:00:01.000Z' })
  assert.equal(markFailed(current, round, {
    error: new Error('permission blocked before model step 2'),
    now: '2026-01-01T00:00:02.000Z',
  }), true)
  assert.equal(current.status, 'failed')
  assert.equal(current.execution.state, 'failed')
  assert.equal(markCompleted(current, round, { now: '2026-01-01T00:00:03.000Z' }), false)
  assert.equal(current.status, 'failed')
  assert.equal(markFailed(current, round, { error: new Error('again') }), false)
})

test('a completed round cannot later be marked failed', () => {
  const current = task()
  const round = beginRound(current, { commandId: 'cmd-start', prompt, now: '2026-01-01T00:00:01.000Z' })
  assert.equal(markCompleted(current, round, { now: '2026-01-01T00:00:02.000Z' }), true)
  assert.equal(markFailed(current, round, { error: new Error('late failure') }), false)
  assert.equal(current.status, 'completed')
})

test('a host restart marks an active task interrupted, not accepted', () => {
  const current = task()
  beginRound(current, { commandId: 'cmd-start', prompt, now: '2026-01-01T00:00:01.000Z' })
  assert.equal(markInterrupted(current, { now: '2026-01-01T00:00:02.000Z' }), true)
  assert.equal(current.status, 'interrupted')
  assert.equal(current.execution.state, 'interrupted')
  assert.equal(isReviewAllowed(current), true)
})

test('rounds cannot start while the task is active', () => {
  const current = task()
  beginRound(current, { commandId: 'cmd-start', prompt, now: '2026-01-01T00:00:01.000Z' })
  assert.throws(() => beginRound(current, { commandId: 'cmd-2', prompt: 'again' }), /is running/)
})

test('creating admits exactly one first round and never a duplicate active round', () => {
  const current = task()
  const round = beginFirstRound(current, { commandId: 'cmd-start', prompt })
  assert.equal(round, 1)
  assert.equal(current.status, 'running')
  assert.equal(current.activeRound, 1)
  assert.throws(() => beginFirstRound(current, { commandId: 'cmd-again', prompt: 'again' }), /not creating/)
  assert.throws(() => beginRound(current, { commandId: 'cmd-again', prompt: 'again', allowFrom: ['creating'] }), /is running/)

  const halfCreated = task()
  halfCreated.rounds.push({ round: 1, commandId: 'cmd-stale', prompt, state: 'pending' })
  assert.throws(() => beginRound(halfCreated, { commandId: 'cmd-2', prompt }), /duplicate first round/)

  const staleActive = task()
  staleActive.status = 'completed'
  staleActive.activeRound = 1
  assert.throws(() => beginRound(staleActive, { commandId: 'cmd-2', prompt }), /already has an active round/)
})
