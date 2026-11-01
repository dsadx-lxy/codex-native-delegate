import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import {
  isOwnedApproval,
  isWithin,
  permissionFromEvents,
  selectPermissionPreset,
  validateCommandCwd,
  validateOwner,
  validatePluginConfig,
} from '../native/plugin/lib/policy.mjs'

const controlRoot = path.join(os.tmpdir(), 'dsh-policy-root')
const allowedRoot = path.dirname(controlRoot)
const outsideRoot = path.join(path.parse(allowedRoot).root, 'dsh-outside-control')

function permissionService(entries) {
  return {
    names: Object.keys(entries),
    resolve(name) {
      if (!Object.hasOwn(entries, name)) throw new Error(`unknown preset ${name}`)
      return entries[name]
    },
  }
}

test('paths outside the authorized project root are rejected', () => {
  assert.equal(isWithin(allowedRoot, path.join(controlRoot, 'nested', 'control')), true)
  assert.equal(isWithin(allowedRoot, outsideRoot), false)
  assert.equal(isWithin(allowedRoot, path.join(allowedRoot, '..', 'other')), false)
})

test('the prototype only selects a workspace-write + ask bundle', () => {
  const service = permissionService({
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  })
  assert.equal(selectPermissionPreset(service), 'workspace-write')
  assert.equal(selectPermissionPreset(service, 'workspace-write'), 'workspace-write')
  assert.throws(() => selectPermissionPreset(service, 'danger-full-access'), /not workspace-write\/ask/)
  assert.throws(() => selectPermissionPreset(service, 'missing'), /not available/)

  const widerOnly = permissionService({
    full: { sandbox: 'danger-full-access', approval: 'never' },
    'write-no-ask': { sandbox: 'workspace-write', approval: 'never' },
  })
  assert.throws(() => selectPermissionPreset(widerOnly), /no available permission preset/)
})

test('cold permission folds the durable knob events and fails closed', () => {
  assert.deepEqual(
    permissionFromEvents(
      [
        { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
        { type: 'approval/policy', data: { policy: 'ask' } },
      ],
      { sandbox: 'danger-full-access', approval: 'never' },
    ),
    { sandbox: 'workspace-write', approval: 'ask' },
  )
  assert.deepEqual(
    permissionFromEvents([{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }], {
      sandbox: 'read-only',
      approval: 'ask',
    }),
    { sandbox: 'danger-full-access', approval: 'ask' },
  )
})

test('approval ownership requires this task, this session, and an active round', () => {
  const req = { agent: { id: 'session-1', session: { id: 'session-1' } } }
  const task = {
    taskId: 'task-1',
    owner: 'owner-1',
    status: 'running',
    activeRound: 1,
    session: { id: 'session-1' },
  }
  assert.equal(isOwnedApproval(task, req), true)
  assert.equal(isOwnedApproval({ ...task, status: 'completed' }, req), false)
  assert.equal(isOwnedApproval({ ...task, activeRound: null }, req), false)
  assert.equal(isOwnedApproval({ ...task, session: { id: 'someone-else' } }, req), false)
  assert.equal(isOwnedApproval(null, req), false)
})

test('owner is required and is a local correlation, not a fixed label', () => {
  assert.equal(validateOwner('thread-abc:1'), 'thread-abc:1')
  assert.throws(() => validateOwner(''), /owner is required/)
  assert.throws(() => validateOwner('bad owner with spaces'), /unsupported characters/)
})

test('plugin config refuses placeholders and keeps control paths inside the roots', () => {
  const base = {
    controlDir: path.join(controlRoot, 'control'),
    controlRoot,
    allowedRoot,
    agentPreset: 'standard',
  }
  const normalized = validatePluginConfig(base)
  assert.equal(normalized.agentPreset, 'standard')
  assert.equal(normalized.allowedRoot, path.resolve(allowedRoot))
  assert.equal(normalized.controlRoot, path.resolve(controlRoot))
  assert.equal(normalized.controlDir, path.resolve(base.controlDir))
  assert.equal(normalized.decisionTimeoutMs, 30 * 60 * 1000)
  assert.throws(() => validatePluginConfig({ ...base, agentPreset: '<desktop-agent-preset-id>' }), /placeholder/)
  assert.throws(
    () => validatePluginConfig({ ...base, controlDir: path.join(outsideRoot, 'control') }),
    /must stay inside/,
  )
  assert.throws(
    () => validatePluginConfig({ ...base, allowedRoot: path.join(controlRoot, 'sub') }),
    /controlRoot must stay inside allowedRoot/,
  )
})

test('task cwd must be an absolute path under the allowed project root', () => {
  const cwd = path.join(controlRoot, 'project')
  assert.equal(validateCommandCwd(cwd, allowedRoot), path.resolve(cwd))
  assert.throws(() => validateCommandCwd('relative/path', allowedRoot), /absolute/)
  assert.throws(() => validateCommandCwd(outsideRoot, allowedRoot), /must stay inside/)
})
