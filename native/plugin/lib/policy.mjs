// Pure policy helpers shared by the Host plugin, the CLI, and the offline tests.
// These decisions are deliberately explicit: this prototype never grants a
// wildcard approval, never inherits a desktop session's permission mode, and
// never trusts a caller-supplied owner as an authentication claim.

import path from 'node:path'

export const REQUIRED_SERVICES = [
  'agents',
  'approval',
  'permissionPresets',
  'sessionController',
  'sessionQuery',
  'sessions',
  'workspaceRegistry',
]

export const MANDATORY_PERMISSION = Object.freeze({
  sandbox: 'workspace-write',
  approval: 'ask',
})

export const ACTIVE_TASK_STATUSES = Object.freeze(['creating', 'running', 'awaiting_approval'])

export function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('path must be a non-empty string')
  return path.resolve(value)
}

export function isWithin(root, target) {
  const rootPath = normalizePath(root)
  const targetPath = normalizePath(target)
  const relative = path.relative(rootPath, targetPath)
  if (relative === '') return true
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  return true
}

export function assertWithin(root, target, label) {
  if (!isWithin(root, target)) {
    throw new Error(`${label} must stay inside ${normalizePath(root)}; got ${normalizePath(target)}`)
  }
  return normalizePath(target)
}

/**
 * Resolve a configured permission preset and prove that its bundle is exactly
 * workspace-write + ask. An explicitly preferred name is only accepted when it
 * resolves to that bundle; otherwise the first configured matching preset is
 * used. No match is a hard failure, never a silent fallback to a wider mode.
 */
export function selectPermissionPreset(service, preferred) {
  if (!service || typeof service.names === 'undefined' || typeof service.resolve !== 'function') {
    throw new Error('permission-presets service is unavailable')
  }
  const names = Array.from(service.names)
  const matches = (name) => {
    const spec = service.resolve(name)
    return spec && spec.sandbox === MANDATORY_PERMISSION.sandbox && spec.approval === MANDATORY_PERMISSION.approval
  }
  if (preferred !== undefined && preferred !== null && preferred !== '') {
    if (!names.includes(preferred)) {
      throw new Error(`configured permission preset "${preferred}" is not available (available: ${names.join(', ')})`)
    }
    if (!matches(preferred)) {
      const spec = service.resolve(preferred)
      throw new Error(
        `configured permission preset "${preferred}" is ${spec?.sandbox}/${spec?.approval}, not workspace-write/ask`,
      )
    }
    return preferred
  }
  const found = names.find(matches)
  if (found === undefined) {
    throw new Error(
      `no available permission preset bundles workspace-write + ask (available: ${names.join(', ')}). ` +
        'Add such a preset to the Desktop permission-presets configuration, or name it explicitly in the plugin config.',
    )
  }
  return found
}

export function permissionBundleMatches(service, session, expectedName) {
  if (!service || typeof service.current !== 'function') return false
  try {
    const current = service.current(session)
    if (expectedName !== undefined && current === expectedName) return true
    const spec = service.resolve(current)
    return spec && spec.sandbox === MANDATORY_PERMISSION.sandbox && spec.approval === MANDATORY_PERMISSION.approval
  } catch {
    return false
  }
}

/**
 * Read the effective permission from a durable cold-Session observation. The
 * last `sandbox/mode` and `approval/policy` events are the same facts the
 * enforcement services fold; a missing event falls back to the deployment
 * default. This is used before a cold continue is allowed to prompt.
 */
export function permissionFromEvents(events, defaults) {
  let sandbox = defaults?.sandbox
  let approval = defaults?.approval
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'sandbox/mode') sandbox = event.data?.mode
    if (event?.type === 'approval/policy') approval = event.data?.policy
  }
  return { sandbox, approval }
}

export function mandatoryPermission(value) {
  return value?.sandbox === MANDATORY_PERMISSION.sandbox && value?.approval === MANDATORY_PERMISSION.approval
}

/**
 * The approval waterfall is process-wide for untagged listeners, but this
 * plugin registers its approval listener on the Agent-scoped context it
 * created. This predicate is the defense-in-depth check inside that listener:
 * an own session with an inactive task must be rejected, never forwarded to
 * the Desktop UI.
 */
export function isOwnedApproval(task, req) {
  if (!task || !req || !req.agent) return false
  const sessionId = req.agent.session?.id
  if (typeof sessionId !== 'string' || task.session?.id !== sessionId) return false
  if (!ACTIVE_TASK_STATUSES.includes(task.status)) return false
  if (task.activeRound === null || task.activeRound === undefined) return false
  return true
}

export function validatePluginConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('plugin config must be an object')
  const controlDir = normalizePath(raw.controlDir)
  const allowedRoot = normalizePath(raw.allowedRoot ?? process.cwd())
  const controlRoot = normalizePath(raw.controlRoot ?? path.join(allowedRoot, 'codex-control'))
  assertWithin(controlRoot, controlDir, 'controlDir')
  if (!isWithin(allowedRoot, controlRoot)) {
    throw new Error('controlRoot must stay inside allowedRoot')
  }
  if (typeof raw.agentPreset !== 'string' || raw.agentPreset.trim() === '') {
    throw new Error('agentPreset is required: name the Desktop agent preset the delegated session must run')
  }
  if (raw.agentPreset.includes('<') || raw.agentPreset.includes('REPLACE')) {
    throw new Error(`agentPreset is still a placeholder (${raw.agentPreset}); set the real Desktop preset id`)
  }
  const decisionTimeoutMs = clampInteger(raw.decisionTimeoutMs ?? 30 * 60 * 1000, 5000, 24 * 60 * 60 * 1000)
  const pollIntervalMs = clampInteger(raw.pollIntervalMs ?? 400, 100, 5000)
  const heartbeatMs = clampInteger(raw.heartbeatMs ?? 5000, 1000, 60000)
  return {
    controlDir,
    controlRoot,
    allowedRoot,
    agentPreset: raw.agentPreset.trim(),
    permissionPreset: typeof raw.permissionPreset === 'string' && raw.permissionPreset.trim() !== ''
      ? raw.permissionPreset.trim()
      : undefined,
    workspaceTitle: typeof raw.workspaceTitle === 'string' && raw.workspaceTitle.trim() !== ''
      ? raw.workspaceTitle.trim()
      : 'Codex 委派',
    decisionTimeoutMs,
    pollIntervalMs,
    heartbeatMs,
  }
}

export function validateCommandCwd(cwd, allowedRoot) {
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new Error('--cwd is required: every delegated task needs its own project directory')
  if (!path.isAbsolute(cwd)) throw new Error(`--cwd must be absolute: ${cwd}`)
  assertWithin(allowedRoot, cwd, 'task cwd')
  return path.resolve(cwd)
}

export function validateOwner(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('owner is required: pass the calling Codex thread/task id, not a fixed label')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(value.trim())) {
    throw new Error('owner contains unsupported characters')
  }
  return value.trim()
}

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export default {
  ACTIVE_TASK_STATUSES,
  MANDATORY_PERMISSION,
  REQUIRED_SERVICES,
  assertWithin,
  isOwnedApproval,
  isWithin,
  mandatoryPermission,
  normalizePath,
  permissionBundleMatches,
  permissionFromEvents,
  selectPermissionPreset,
  validateCommandCwd,
  validateOwner,
  validatePluginConfig,
}
