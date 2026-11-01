import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  atomicWriteJson,
  controlLayout,
  ensureLayout,
  listJson,
  moveInto,
  readJson,
} from '../native/plugin/lib/store.mjs'
import {
  buildCancelCommand,
  buildContinueCommand,
  buildDecision,
  buildReview,
  buildStartCommand,
  commandFileName,
  validateCommand,
  validateDecision,
} from '../native/plugin/lib/commands.mjs'

async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-store-'))
  await ensureLayout(dir)
  return dir
}

test('exclusive JSON writes refuse to overwrite an existing command', async () => {
  const dir = await workspace()
  const file = path.join(dir, 'commands', 'one.json')
  await atomicWriteJson(file, { value: 1 }, { exclusive: true })
  await assert.rejects(() => atomicWriteJson(file, { value: 2 }, { exclusive: true }), /EEXIST/)
  assert.deepEqual(await readJson(file), { value: 1 })
})

test('queue listing sorts files and tolerates invalid JSON visibly', async () => {
  const dir = await workspace()
  const layout = controlLayout(dir)
  await atomicWriteJson(path.join(layout.commands, '002.json'), { n: 2 })
  await atomicWriteJson(path.join(layout.commands, '001.json'), { n: 1 })
  await fs.writeFile(path.join(layout.commands, '003.json'), '{not json', 'utf8')
  const items = await listJson(layout.commands)
  assert.deepEqual(items.map((item) => item.value?.n ?? item.value), [1, 2, null])
})

test('moveInto archives a command and reports a vanished source', async () => {
  const dir = await workspace()
  const layout = controlLayout(dir)
  const file = path.join(layout.commands, 'move.json')
  await atomicWriteJson(file, { ok: true })
  const moved = await moveInto(file, layout.commandsProcessed, 'move.json')
  assert.equal(moved, path.join(layout.commandsProcessed, 'move.json'))
  assert.equal(await moveInto(file, layout.commandsProcessed, 'move.json'), null)
})

test('command builders produce validated, unique wire records with owner and cwd', () => {
  const start = buildStartCommand({
    taskId: 'task-1',
    prompt: 'do it',
    owner: 'thread-1',
    cwd: path.join(os.tmpdir(), 'dsh-test-project'),
  })
  assert.equal(validateCommand(start), start)
  assert.equal(start.owner, 'thread-1')
  assert.match(commandFileName(start), /^\d{13}-cmd-.*\.json$/)
  const again = buildStartCommand({
    taskId: 'task-1',
    prompt: 'do it',
    owner: 'thread-1',
    cwd: path.join(os.tmpdir(), 'dsh-test-project'),
  })
  assert.notEqual(start.commandId, again.commandId)

  const cont = buildContinueCommand({ taskId: 'task-1', prompt: 'again', owner: 'thread-1' })
  assert.equal(validateCommand(cont).kind, 'continue')
  const cancel = buildCancelCommand({ taskId: 'task-1', owner: 'thread-1' })
  assert.equal(validateCommand(cancel).kind, 'cancel')
  assert.throws(() => validateCommand({ ...start, kind: 'delete-everything' }), /unsupported command kind/)
  assert.throws(
    () => validateCommand({ ...cont, owner: '' }),
    /owner is required/,
  )
})

test('decisions are one-shot-shaped, owner-bound, and reject without a reason', () => {
  const allow = buildDecision({ requestId: 'apr-1', decision: 'allow', owner: 'thread-1' })
  assert.equal(validateDecision(allow, 'apr-1', 'thread-1').ok, true)
  assert.equal(validateDecision(allow, 'apr-2', 'thread-1').ok, false)
  assert.equal(validateDecision(allow, 'apr-1', 'other-thread').ok, false)
  const reject = buildDecision({ requestId: 'apr-1', decision: 'reject', owner: 'thread-1', reason: 'outside scope' })
  assert.equal(validateDecision(reject, 'apr-1', 'thread-1').ok, true)
  assert.throws(() => buildDecision({ requestId: 'apr-1', decision: 'reject', owner: 'thread-1' }), /rejection reason/)
  assert.equal(validateDecision({ ...allow, decision: 'allow-always' }, 'apr-1', 'thread-1').ok, false)
})

test('review records carry the owner and execution round they judge', () => {
  const review = buildReview({
    taskId: 'task-1',
    round: 2,
    sessionId: 'session-1',
    owner: 'thread-1',
    executionState: 'completed',
    verdict: 'accepted',
    evidence: 'node --test passed',
  })
  assert.equal(review.round, 2)
  assert.equal(review.owner, 'thread-1')
  assert.equal(review.verdict, 'accepted')
  assert.throws(
    () => buildReview({ taskId: 'task-1', round: 1, sessionId: 's', owner: 'thread-1', executionState: 'running', verdict: 'maybe', evidence: 'x' }),
    /verdict/,
  )
})
