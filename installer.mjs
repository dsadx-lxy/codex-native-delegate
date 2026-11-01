#!/usr/bin/env node
// Portable installer for the Codex-native Harness plugin.
//
// Machine-specific values come from explicit CLI options, environment variables,
// or a local JSON config beside this installer. The installer itself contains no
// username, drive letter, or fixed Desktop profile path. It only inserts or
// updates the one managed entry block, writes a no-credential backup, and never
// copies plugin code into the user profile.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_ENTRY_ID = 'codex-native-delegate'
const DEFAULT_AGENT_PRESET = 'standard'
const DEFAULT_PERMISSION_PRESET = 'workspace-write'
const DEFAULT_WORKSPACE_TITLE = 'Codex 委派'
const DEFAULT_DECISION_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 400
const DEFAULT_HEARTBEAT_MS = 5000
const CONFIG_CANDIDATES = ['installer.local.json', 'installer.config.json']

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function markers(entryId = DEFAULT_ENTRY_ID) {
  return {
    start: `# >>> ${entryId} (managed by installer.mjs) >>>`,
    end: `# <<< ${entryId} <<<`,
  }
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function statSafe(file) {
  return await fs.stat(file).catch(() => null)
}

function parseArgs(argv) {
  const flags = { apply: false, verify: false, versioned: false, help: false }
  const values = {}
  const booleanNames = new Set(['apply', 'verify', 'versioned', 'help'])
  const valueNames = new Set([
    'config',
    'plugin-root',
    'profile',
    'profile-path',
    'allowed-root',
    'control-dir',
    'control-root',
    'entry-file',
    'implementation-dir',
    'releases-dir',
    'records-dir',
    'entry-id',
    'agent-preset',
    'permission-preset',
    'workspace-title',
    'baseline-sha256',
    'decision-timeout-ms',
    'poll-interval-ms',
    'heartbeat-ms',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const [name, inline] = arg.slice(2).split('=', 2)
    if (booleanNames.has(name)) {
      flags[name] = true
      continue
    }
    if (!valueNames.has(name)) throw new Error(`unknown installer option: --${name}`)
    const value = inline ?? argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`)
    values[name] = value
  }
  return { flags, values }
}

async function loadConfig(installerPath, explicitConfig) {
  const installerDir = path.dirname(installerPath)
  let configPath = null
  if (explicitConfig) {
    configPath = path.resolve(explicitConfig)
    const stat = await statSafe(configPath)
    if (!stat?.isFile()) throw new Error(`installer config not found: ${configPath}`)
  } else {
    for (const candidate of CONFIG_CANDIDATES) {
      const full = path.join(installerDir, candidate)
      if ((await statSafe(full))?.isFile()) {
        configPath = full
        break
      }
    }
  }
  if (configPath === null) return { config: {}, configPath: null, configDir: installerDir }
  let config
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot parse installer config ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('installer config must be a JSON object')
  }
  return { config, configPath, configDir: path.dirname(configPath) }
}

function camelOf(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

function pickValue(name, envName, { values, config, argsCwd, configDir, env }) {
  if (values[name] !== undefined) return { value: values[name], base: argsCwd, kind: 'args' }
  const camel = camelOf(name)
  if (config[name] !== undefined) return { value: config[name], base: configDir, kind: 'config' }
  if (config[camel] !== undefined) return { value: config[camel], base: configDir, kind: 'config' }
  if (name === 'baseline-sha256' && config.profileBaselineSha256 !== undefined) {
    return { value: config.profileBaselineSha256, base: configDir, kind: 'config' }
  }
  if (envName && env[envName] !== undefined && env[envName] !== '') {
    return { value: env[envName], base: argsCwd, kind: 'env' }
  }
  return null
}

function resolvePickedPath(picked) {
  return picked === null ? null : path.resolve(picked.base, String(picked.value))
}

function resolvePluginRelative(picked, pluginRoot, fallback) {
  if (picked === null) return fallback === undefined ? null : path.resolve(fallback)
  const value = String(picked.value)
  if (path.isAbsolute(value)) return path.resolve(value)
  if (picked.kind === 'config') return path.resolve(pluginRoot, value)
  return path.resolve(picked.base, value)
}

function integerValue(picked, fallback, min, max) {
  const raw = picked === null ? fallback : Number(picked.value)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(raw)))
}

export async function resolveSettings({
  args,
  config,
  configDir,
  installerPath,
  argsCwd = process.cwd(),
  env = process.env,
} = {}) {
  const values = args?.values ?? {}
  const installerDir = path.dirname(path.resolve(installerPath))
  const source = { values, config: config ?? {}, argsCwd, configDir: configDir ?? installerDir, env }

  const pluginRootPick = pickValue('plugin-root', 'DSH_CODEX_PLUGIN_ROOT', source)
  let pluginRoot
  if (pluginRootPick !== null) {
    pluginRoot = resolvePickedPath(pluginRootPick)
  } else if ((await statSafe(path.join(installerDir, 'native.mjs')))?.isFile()) {
    pluginRoot = installerDir
  } else if ((await statSafe(path.join(path.dirname(installerDir), 'native.mjs')))?.isFile()) {
    pluginRoot = path.dirname(installerDir)
  } else {
    pluginRoot = installerDir
  }
  pluginRoot = path.resolve(pluginRoot)

  const entryPick = pickValue('entry-file', 'DSH_CODEX_ENTRY_FILE', source)
  const entryFile = resolvePluginRelative(entryPick, pluginRoot, path.join(pluginRoot, 'native.mjs'))

  const implementationPick = pickValue('implementation-dir', 'DSH_CODEX_IMPLEMENTATION_DIR', source)
  let implementationDir
  if (implementationPick !== null) {
    implementationDir = resolvePluginRelative(implementationPick, pluginRoot)
  } else if ((await statSafe(path.join(pluginRoot, 'native', 'plugin')))?.isDirectory()) {
    implementationDir = path.join(pluginRoot, 'native', 'plugin')
  } else {
    implementationDir = path.join(pluginRoot, 'plugin')
  }

  const defaultReleases = isWithin(path.join(pluginRoot, 'native'), implementationDir)
    ? path.join(pluginRoot, 'native', 'releases')
    : path.join(pluginRoot, 'releases')
  const releasesPick = pickValue('releases-dir', 'DSH_CODEX_RELEASES_DIR', source)
  const releasesDir = resolvePluginRelative(releasesPick, pluginRoot, defaultReleases)

  const controlPick = pickValue('control-dir', 'DSH_CODEX_CONTROL_DIR', source)
  const controlDir = resolvePluginRelative(
    controlPick,
    pluginRoot,
    path.resolve(path.dirname(implementationDir), 'control'),
  )

  const controlRootPick = pickValue('control-root', 'DSH_CODEX_CONTROL_ROOT', source)
  const controlRoot = resolvePluginRelative(controlRootPick, pluginRoot, pluginRoot)

  const allowedPick = pickValue('allowed-root', 'DSH_CODEX_ALLOWED_ROOT', source)
  const allowedRoot = resolvePluginRelative(allowedPick, pluginRoot, pluginRoot)

  const profilePick =
    pickValue('profile', 'DSH_CODEX_PROFILE', source) ?? pickValue('profile-path', 'DSH_CODEX_PROFILE', source)
  const home = env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(os.homedir(), '.dsh')
  const profilePath = profilePick === null
    ? path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    : path.resolve(profilePick.base, String(profilePick.value))

  const baselinePick = pickValue('baseline-sha256', 'DSH_CODEX_PROFILE_BASELINE_SHA256', source)
  const baseline = baselinePick === null ? null : String(baselinePick.value).trim().toLowerCase()
  if (baseline !== null && !/^[a-f0-9]{64}$/.test(baseline)) {
    throw new Error('baseline SHA256 must be 64 hex characters')
  }

  const recordsPick = pickValue('records-dir', 'DSH_CODEX_RECORDS_DIR', source)
  const recordsDir = resolvePluginRelative(recordsPick, pluginRoot, path.join(pluginRoot, 'install-records'))

  const entryId = String(pickValue('entry-id', 'DSH_CODEX_ENTRY_ID', source)?.value ?? DEFAULT_ENTRY_ID).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entryId)) throw new Error('entry-id is not a safe identifier')

  const agentPreset = String(
    pickValue('agent-preset', 'DSH_CODEX_AGENT_PRESET', source)?.value ?? DEFAULT_AGENT_PRESET,
  ).trim()
  const permissionPreset = String(
    pickValue('permission-preset', 'DSH_CODEX_PERMISSION_PRESET', source)?.value ?? DEFAULT_PERMISSION_PRESET,
  ).trim()
  const workspaceTitle = String(
    pickValue('workspace-title', 'DSH_CODEX_WORKSPACE_TITLE', source)?.value ?? DEFAULT_WORKSPACE_TITLE,
  ).trim()
  if (agentPreset === '') throw new Error('agent-preset cannot be empty')
  if (permissionPreset === '') throw new Error('permission-preset cannot be empty')

  const decisionTimeoutMs = integerValue(
    pickValue('decision-timeout-ms', 'DSH_CODEX_DECISION_TIMEOUT_MS', source),
    DEFAULT_DECISION_TIMEOUT_MS,
    5000,
    24 * 60 * 60 * 1000,
  )
  const pollIntervalMs = integerValue(
    pickValue('poll-interval-ms', 'DSH_CODEX_POLL_INTERVAL_MS', source),
    DEFAULT_POLL_INTERVAL_MS,
    100,
    5000,
  )
  const heartbeatMs = integerValue(
    pickValue('heartbeat-ms', 'DSH_CODEX_HEARTBEAT_MS', source),
    DEFAULT_HEARTBEAT_MS,
    1000,
    60000,
  )

  const settings = {
    installerPath: path.resolve(installerPath),
    pluginRoot,
    entryFile,
    implementationDir,
    releasesDir,
    recordsDir,
    recordPath: path.join(recordsDir, `${entryId}-install.json`),
    controlDir,
    controlRoot,
    allowedRoot,
    profilePath,
    profileBaselineSha256: baseline,
    entryId,
    agentPreset,
    permissionPreset,
    workspaceTitle,
    decisionTimeoutMs,
    pollIntervalMs,
    heartbeatMs,
  }
  await validateSettings(settings)
  return settings
}

async function resolveRealTarget(target) {
  const resolved = path.resolve(target)
  const exact = await fs.realpath(resolved).catch((error) => {
    if (error && error.code === 'ENOENT') return null
    throw error
  })
  if (exact !== null) return exact
  let current = resolved
  const tail = []
  for (;;) {
    const parent = path.dirname(current)
    if (parent === current) return null
    tail.unshift(path.basename(current))
    current = parent
    const real = await fs.realpath(current).catch((error) => {
      if (error && error.code === 'ENOENT') return null
      throw error
    })
    if (real !== null) {
      const stat = await statSafe(current)
      if (stat !== null && !stat.isDirectory()) return null
      return path.join(real, ...tail)
    }
  }
}

function isWithinReal(realRoot, realTarget) {
  const normalize = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value
  const relative = path.relative(normalize(realRoot), normalize(realTarget))
  if (relative === '') return true
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

async function assertRealWithin(root, target, label) {
  const realRoot = await fs.realpath(root).catch((error) => {
    throw new Error(`${label} root is not readable: ${root}: ${error instanceof Error ? error.message : String(error)}`)
  })
  const realTarget = await resolveRealTarget(target)
  if (realTarget === null) throw new Error(`${label} has no resolvable existing ancestor: ${target}`)
  if (!isWithinReal(realRoot, realTarget)) {
    throw new Error(`${label} escapes its root via link or path: ${target} -> ${realTarget}`)
  }
  return { realRoot, realTarget }
}

export async function validateSettings(settings) {
  const pluginRootStat = await statSafe(settings.pluginRoot)
  if (!pluginRootStat?.isDirectory()) throw new Error(`plugin root is not a directory: ${settings.pluginRoot}`)
  if (!isWithin(settings.pluginRoot, settings.entryFile)) throw new Error('entry file must stay inside the plugin root')
  if (!isWithin(settings.pluginRoot, settings.implementationDir)) {
    throw new Error('implementation directory must stay inside the plugin root')
  }
  if (!isWithin(settings.pluginRoot, settings.releasesDir)) {
    throw new Error('releases directory must stay inside the plugin root')
  }
  if (!isWithin(settings.allowedRoot, settings.controlRoot)) {
    throw new Error('control root must stay inside the allowed root')
  }
  if (!isWithin(settings.controlRoot, settings.controlDir)) {
    throw new Error('control directory must stay inside the control root')
  }
  if (!isWithin(settings.allowedRoot, settings.recordsDir)) {
    throw new Error('records directory must stay inside the allowed root')
  }
  if (!path.isAbsolute(settings.profilePath) || !/\.ya?ml$/i.test(settings.profilePath)) {
    throw new Error('profile path must be an absolute .yml/.yaml file')
  }
  if (!(await statSafe(settings.allowedRoot))?.isDirectory()) {
    throw new Error(`allowed root is missing: ${settings.allowedRoot}`)
  }
  if (!(await statSafe(settings.controlRoot))?.isDirectory()) {
    throw new Error(`control root is missing: ${settings.controlRoot}`)
  }
  await assertRealWithin(settings.pluginRoot, settings.entryFile, 'entry file')
  await assertRealWithin(settings.pluginRoot, settings.implementationDir, 'implementation directory')
  await assertRealWithin(settings.pluginRoot, settings.releasesDir, 'releases directory')
  await assertRealWithin(settings.allowedRoot, settings.controlRoot, 'control root')
  await assertRealWithin(settings.controlRoot, settings.controlDir, 'control directory')
  await assertRealWithin(settings.allowedRoot, settings.recordsDir, 'records directory')
  if (!(await statSafe(settings.entryFile))?.isFile()) throw new Error(`entry file is missing: ${settings.entryFile}`)
  if (!(await statSafe(settings.implementationDir))?.isDirectory()) {
    throw new Error(`implementation directory is missing: ${settings.implementationDir}`)
  }
  if (!(await statSafe(settings.profilePath))?.isFile()) throw new Error(`profile is missing: ${settings.profilePath}`)
  return true
}

function entryUrl(entryPath) {
  return pathToFileURL(entryPath).href
}

export function renderBlock(settings, entryPath = settings.entryFile) {
  const { start, end } = markers(settings.entryId)
  return [
    start,
    '- insert:',
    `    - id: ${settings.entryId}`,
    `      name: ${quote(entryUrl(entryPath))}`,
    '      config:',
    `        controlDir: ${quote(settings.controlDir.replaceAll('\\', '/'))}`,
    `        controlRoot: ${quote(settings.controlRoot.replaceAll('\\', '/'))}`,
    `        allowedRoot: ${quote(settings.allowedRoot.replaceAll('\\', '/'))}`,
    `        agentPreset: ${quote(settings.agentPreset)}`,
    `        permissionPreset: ${quote(settings.permissionPreset)}`,
    `        workspaceTitle: ${quote(settings.workspaceTitle)}`,
    `        decisionTimeoutMs: ${settings.decisionTimeoutMs}`,
    `        pollIntervalMs: ${settings.pollIntervalMs}`,
    `        heartbeatMs: ${settings.heartbeatMs}`,
    end,
    '',
  ].join('\n')
}

export function managedBlock(text, entryId = DEFAULT_ENTRY_ID) {
  const { start, end } = markers(entryId)
  const startIndex = text.indexOf(start)
  const endIndex = text.indexOf(end)
  if (startIndex < 0 && endIndex < 0) return null
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(`profile contains only one of the ${entryId} managed markers`)
  }
  const after = text.indexOf('\n', endIndex)
  return text.slice(startIndex, after < 0 ? text.length : after + 1)
}

function normalizeManagedBlock(block) {
  return block.replace(/^(\s*name:).*$/m, '$1 <entry>')
}

export function replaceManagedBlock(text, block, entryId = DEFAULT_ENTRY_ID) {
  const { start, end } = markers(entryId)
  const startIndex = text.indexOf(start)
  const endIndex = text.indexOf(end)
  if (startIndex < 0 || endIndex < startIndex) throw new Error('profile has no complete managed block to replace')
  const after = text.indexOf('\n', endIndex)
  const suffix = text.slice(after < 0 ? text.length : after + 1)
  return `${text.slice(0, startIndex)}${block}${suffix}`
}

export function blockEntryUrl(block) {
  return block.match(/^\s*name:\s*'([^']+)'/m)?.[1] ?? null
}

function isReplaceRefused(error) {
  return Boolean(
    error && (error.code === 'EPERM' || error.code === 'EEXIST' || error.code === 'EACCES' || error.code === 'EBUSY'),
  )
}

async function restoreProfile(file, originalText, backupPath, ops) {
  const expectedHash = sha256(originalText)
  try {
    await ops.writeFile(file, originalText, { encoding: 'utf8' })
  } catch (writeError) {
    if (!backupPath) {
      throw new Error(
        `CRITICAL: profile restore failed and no backup path is available: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        { cause: writeError },
      )
    }
    try {
      await ops.copyFile(backupPath, file)
    } catch (copyError) {
      throw new Error(
        `CRITICAL: profile restore failed; original backup remains at ${backupPath}: ${copyError instanceof Error ? copyError.message : String(copyError)}`,
        { cause: copyError },
      )
    }
  }
  const restored = await ops.readFile(file, 'utf8')
  if (sha256(restored) !== expectedHash) {
    throw new Error(
      `CRITICAL: profile restore verification failed; original backup remains at ${backupPath ?? '(no backup path)'}`,
    )
  }
  return expectedHash
}

/**
 * Replace one text file without ever deleting the original first. A failed
 * Windows rename leaves the original untouched; if it is missing or a written
 * profile fails verification, the pre-install text is restored from the backup.
 */
export async function safeInstallProfile({ file, originalText, installedText, backupPath, ops = fs }) {
  const originalHash = sha256(originalText)
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.codex-native-delegate-${process.pid}-${crypto.randomUUID()}.tmp`)
  await ops.writeFile(tmp, installedText, { encoding: 'utf8', flag: 'wx' })
  try {
    try {
      await ops.rename(tmp, file)
    } catch (error) {
      if (!isReplaceRefused(error)) {
        await ops.rm(tmp, { force: true }).catch(() => {})
        throw error
      }
      const current = await ops.readFile(file, 'utf8').catch((readError) => {
        if (readError && readError.code === 'ENOENT') return null
        throw readError
      })
      if (current === null || current.trim() === '') {
        await restoreProfile(file, originalText, backupPath, ops)
        throw new Error(
          `Windows replace refused (${error.code}); missing or empty profile was restored from backup ${backupPath ?? '(no backup path)'}`,
        )
      }
      if (sha256(current) !== originalHash) {
        throw new Error(
          `Windows replace refused (${error.code}); profile changed unexpectedly and was not overwritten; backup ${backupPath ?? '(no backup path)'}`,
        )
      }
      throw new Error(
        `Windows replace refused (${error.code}); original profile left unchanged; backup ${backupPath ?? '(no backup path)'}`,
      )
    }
    const written = await ops.readFile(file, 'utf8')
    if (written !== installedText) {
      await restoreProfile(file, originalText, backupPath, ops)
      throw new Error(
        `installed profile verification failed; original profile restored from backup ${backupPath ?? '(no backup path)'}`,
      )
    }
    return { profileSha256: sha256(written), originalSha256: originalHash }
  } finally {
    await ops.rm(tmp, { force: true }).catch(() => {})
  }
}

export async function hashCodeScope(settings) {
  const files = []
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === 'control' || entry.name === 'install-records' || entry.name === 'releases') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const buffer = await fs.readFile(full)
        files.push({
          path: path.relative(settings.pluginRoot, full).replaceAll('\\', '/'),
          sha256: sha256Buffer(buffer),
        })
      }
    }
  }
  const entry = await fs.readFile(settings.entryFile)
  files.push({
    path: path.relative(settings.pluginRoot, settings.entryFile).replaceAll('\\', '/'),
    sha256: sha256Buffer(entry),
  })
  await walk(settings.implementationDir)
  files.sort((left, right) => left.path.localeCompare(right.path))
  return {
    root: settings.pluginRoot,
    files,
    aggregateSha256: sha256(files.map((file) => `${file.sha256}  ${file.path}\n`).join('')),
  }
}

export async function hashPluginGraph(settings) {
  const files = []
  async function walk(dir, relative) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) await walk(full, rel)
      else if (entry.isFile()) {
        const buffer = await fs.readFile(full)
        files.push({ path: rel, source: full, sha256: sha256Buffer(buffer) })
      }
    }
  }
  await walk(settings.implementationDir, 'plugin')
  files.sort((left, right) => left.path.localeCompare(right.path))
  return {
    files,
    aggregateSha256: sha256(files.map((file) => `${file.sha256}  ${file.path}\n`).join('')),
  }
}

async function verifyRelease(releaseDir, manifest) {
  for (const file of manifest.files) {
    const target = path.join(releaseDir, ...file.path.split('/'))
    const buffer = await fs.readFile(target)
    if (sha256Buffer(buffer) !== file.sha256) throw new Error(`release file hash mismatch: ${file.path}`)
  }
  const entry = await fs.readFile(path.join(releaseDir, 'native-plugin.mjs'))
  if (sha256Buffer(entry) !== manifest.entrySha256) throw new Error('release entry hash mismatch')
}

export async function planVersionedRelease(settings, { releasesDir = settings.releasesDir } = {}) {
  const graph = await hashPluginGraph(settings)
  const releaseId = `release-${graph.aggregateSha256.slice(0, 16)}`
  const releaseDir = path.join(releasesDir, releaseId)
  return { releaseId, releaseDir, entryPath: path.join(releaseDir, 'native-plugin.mjs'), graph }
}

export async function stageVersionedRelease(settings, { releasesDir = settings.releasesDir } = {}) {
  const planned = await planVersionedRelease(settings, { releasesDir })
  const { releaseId, releaseDir, entryPath, graph } = planned
  const entryText = [
    '// Versioned native plugin entry. The complete plugin graph is copied below',
    '// so the Loader imports a fresh module URL instead of the cached stable one.',
    "export { default, name, version, apply } from './plugin/index.mjs'",
    '',
  ].join('\n')
  const manifestText = `${JSON.stringify(
    {
      schema: 1,
      releaseId,
      pluginAggregateSha256: graph.aggregateSha256,
      entrySha256: sha256(entryText),
      files: graph.files.map(({ path: filePath, sha256: hash }) => ({ path: filePath, sha256: hash })),
    },
    null,
    2,
  )}\n`
  const existing = await statSafe(releaseDir)
  if (existing) {
    const manifest = JSON.parse(await fs.readFile(path.join(releaseDir, 'release.json'), 'utf8'))
    if (manifest.pluginAggregateSha256 !== graph.aggregateSha256 || manifest.entrySha256 !== sha256(entryText)) {
      throw new Error(`existing release ${releaseId} does not match the current plugin graph; refusing to overwrite`)
    }
    await verifyRelease(releaseDir, manifest)
    return { releaseId, releaseDir, entryPath, created: false, graph }
  }
  await fs.mkdir(releasesDir, { recursive: true })
  const tempDir = path.join(releasesDir, `.${releaseId}.tmp-${process.pid}-${crypto.randomUUID()}`)
  await fs.mkdir(tempDir, { recursive: true })
  try {
    for (const file of graph.files) {
      const target = path.join(tempDir, ...file.path.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(file.source, target)
      const copied = await fs.readFile(target)
      if (sha256Buffer(copied) !== file.sha256) throw new Error(`release copy hash mismatch: ${file.path}`)
    }
    await fs.writeFile(path.join(tempDir, 'native-plugin.mjs'), entryText, 'utf8')
    await fs.writeFile(path.join(tempDir, 'release.json'), manifestText, 'utf8')
    await verifyRelease(tempDir, JSON.parse(manifestText))
    await fs.rename(tempDir, releaseDir)
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return { releaseId, releaseDir, entryPath, created: true, graph }
}

async function makeBackup(settings, originalText) {
  await fs.mkdir(settings.recordsDir, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const backupPath = path.join(settings.recordsDir, `desktop-cordis.patch.${stamp}.yml`)
  await fs.writeFile(backupPath, originalText, { encoding: 'utf8', flag: 'wx' })
  return { backupPath, backupHash: sha256(originalText) }
}

async function readRecord(settings) {
  try {
    return JSON.parse(await fs.readFile(settings.recordPath, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new Error(`cannot read install record: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeRecord(settings, record) {
  await fs.mkdir(settings.recordsDir, { recursive: true })
  await fs.writeFile(settings.recordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
}

export async function main(argv = process.argv.slice(2), { installerPath = fileURLToPath(import.meta.url) } = {}) {
  const args = parseArgs(argv)
  if (args.flags.help) {
    process.stdout.write(
      [
        'usage: node installer.mjs [--config file] [--apply] [--verify] [--versioned]',
        '',
        'Paths may come from CLI flags, environment, or installer.local.json beside this file.',
        'Common flags: --plugin-root --profile --allowed-root --control-dir --control-root',
        '              --entry-file --implementation-dir --releases-dir --records-dir',
        '              --entry-id --agent-preset --permission-preset --workspace-title',
        '              --baseline-sha256',
        '',
        'Without --apply this is a read-only dry run. --versioned stages a complete',
        'plugin graph under releases and changes only this entry row to the new URL.',
        'A new insert requires --baseline-sha256 (or the config/env equivalent).',
        '',
      ].join('\n'),
    )
    return 0
  }

  const loaded = await loadConfig(installerPath, args.values.config)
  const settings = await resolveSettings({
    args,
    config: loaded.config,
    configDir: loaded.configDir,
    installerPath,
  })
  const entryHash = sha256Buffer(await fs.readFile(settings.entryFile))
  const codeScope = await hashCodeScope(settings)
  const originalText = await fs.readFile(settings.profilePath, 'utf8')
  const originalHash = sha256(originalText)
  const stableBlock = renderBlock(settings)
  const existingBlock = managedBlock(originalText, settings.entryId)
  const baseOutput = {
    profilePath: settings.profilePath,
    pluginRoot: settings.pluginRoot,
    entryFile: settings.entryFile,
    implementationDir: settings.implementationDir,
    controlDir: settings.controlDir,
    allowedRoot: settings.allowedRoot,
    entryId: settings.entryId,
    stableEntrySha256: entryHash,
    codeScopeAggregateSha256: codeScope.aggregateSha256,
    configPath: loaded.configPath,
  }

  if (existingBlock !== null) {
    if (normalizeManagedBlock(existingBlock) !== normalizeManagedBlock(stableBlock)) {
      throw new Error(
        `profile already contains a different ${settings.entryId} managed block; refusing to overwrite it`,
      )
    }
    let release = null
    let desiredBlock = stableBlock
    if (args.flags.versioned) {
      if (args.flags.apply) await validateSettings(settings)
      release = args.flags.apply ? await stageVersionedRelease(settings) : await planVersionedRelease(settings)
      desiredBlock = renderBlock(settings, release.entryPath)
    }
    if (existingBlock === desiredBlock) {
      const record = await readRecord(settings)
      process.stdout.write(
        `${JSON.stringify(
          {
            ...baseOutput,
            status: args.flags.verify ? 'verified' : 'already-installed',
            profileSha256: originalHash,
            entryUrl: blockEntryUrl(existingBlock),
            releaseId: release?.releaseId ?? null,
            releaseDir: release?.releaseDir ?? null,
            backupPath: record?.backupPath ?? null,
            backupSha256: record?.backupSha256 ?? null,
            wrote: false,
          },
          null,
          2,
        )}\n`,
      )
      return 0
    }
    const installedText = replaceManagedBlock(originalText, desiredBlock, settings.entryId)
    const planned = {
      ...baseOutput,
      status: args.flags.apply ? 'updating' : 'dry-run-update',
      profileBeforeSha256: originalHash,
      profileAfterSha256: sha256(installedText),
      oldEntryUrl: blockEntryUrl(existingBlock),
      newEntryUrl: blockEntryUrl(desiredBlock),
      releaseId: release?.releaseId ?? null,
      releaseDir: release?.releaseDir ?? null,
      wrote: false,
    }
    if (!args.flags.apply) {
      process.stdout.write(`${JSON.stringify(planned, null, 2)}\n`)
      return 0
    }
    await validateSettings(settings)
    const backup = await makeBackup(settings, originalText)
    await validateSettings(settings)
    const writeResult = await safeInstallProfile({
      file: settings.profilePath,
      originalText,
      installedText,
      backupPath: backup.backupPath,
    })
    const writtenText = await fs.readFile(settings.profilePath, 'utf8')
    if (!writtenText.includes(desiredBlock) || writtenText.includes(existingBlock)) {
      throw new Error('profile update verification failed: old managed row was not replaced exactly')
    }
    const record = {
      schema: 1,
      installedAt: new Date().toISOString(),
      profilePath: settings.profilePath,
      profileBeforeSha256: originalHash,
      profileAfterSha256: writeResult.profileSha256,
      backupPath: backup.backupPath,
      backupSha256: backup.backupHash,
      entryId: settings.entryId,
      entryUrl: blockEntryUrl(desiredBlock),
      releaseId: release?.releaseId ?? null,
      releaseDir: release?.releaseDir ?? null,
      pluginRoot: settings.pluginRoot,
      controlDir: settings.controlDir,
      allowedRoot: settings.allowedRoot,
      codeScope,
      note: 'Backup contains the pre-update profile only; no credentials or session logs.',
    }
    await validateSettings(settings)
    await writeRecord(settings, record)
    process.stdout.write(
      `${JSON.stringify(
        {
          ...baseOutput,
          status: 'updated',
          profileBeforeSha256: originalHash,
          profileAfterSha256: writeResult.profileSha256,
          backupPath: backup.backupPath,
          backupSha256: backup.backupHash,
          recordPath: settings.recordPath,
          entryUrl: blockEntryUrl(desiredBlock),
          releaseId: release?.releaseId ?? null,
          releaseDir: release?.releaseDir ?? null,
          wrote: true,
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }

  if (args.flags.versioned) throw new Error('--versioned requires an existing managed block to update')
  if (originalText.includes(`id: ${settings.entryId}`)) {
    throw new Error(`profile contains id ${settings.entryId} outside the managed block; refusing to guess or overwrite it`)
  }
  if (settings.profileBaselineSha256 === null) {
    throw new Error(
      `profile has no managed block; set --baseline-sha256 (current ${originalHash}) before the first insert`,
    )
  }
  if (originalHash !== settings.profileBaselineSha256) {
    throw new Error(
      `profile baseline mismatch: expected ${settings.profileBaselineSha256}, got ${originalHash}; refusing to overwrite`,
    )
  }

  const separator = originalText.endsWith('\n') ? '\n' : '\n\n'
  const installedText = `${originalText}${separator}${stableBlock}`
  const planned = {
    ...baseOutput,
    status: args.flags.apply ? 'installing' : 'dry-run',
    profileSha256: originalHash,
    baselineSha256: settings.profileBaselineSha256,
    installedSha256: sha256(installedText),
    entryUrl: entryUrl(settings.entryFile),
    wrote: false,
  }
  if (!args.flags.apply) {
    process.stdout.write(`${JSON.stringify(planned, null, 2)}\n`)
    return 0
  }

  await validateSettings(settings)
  const backup = await makeBackup(settings, originalText)
  await validateSettings(settings)
  const writeResult = await safeInstallProfile({
    file: settings.profilePath,
    originalText,
    installedText,
    backupPath: backup.backupPath,
  })
  const writtenText = await fs.readFile(settings.profilePath, 'utf8')
  if (!writtenText.startsWith(originalText) || !writtenText.includes(stableBlock)) {
    throw new Error('installed profile does not preserve the original lines and the new managed row')
  }
  const record = {
    schema: 1,
    installedAt: new Date().toISOString(),
    profilePath: settings.profilePath,
    profileBeforeSha256: originalHash,
    profileAfterSha256: writeResult.profileSha256,
    backupPath: backup.backupPath,
    backupSha256: backup.backupHash,
    entryId: settings.entryId,
    entryUrl: entryUrl(settings.entryFile),
    pluginRoot: settings.pluginRoot,
    controlDir: settings.controlDir,
    allowedRoot: settings.allowedRoot,
    codeScope,
    note: 'Backup contains the pre-install profile only; no credentials or session logs.',
  }
  await validateSettings(settings)
  await writeRecord(settings, record)
  process.stdout.write(
    `${JSON.stringify(
      {
        ...baseOutput,
        status: 'installed',
        profileBeforeSha256: originalHash,
        profileAfterSha256: writeResult.profileSha256,
        backupPath: backup.backupPath,
        backupSha256: backup.backupHash,
        recordPath: settings.recordPath,
        entryUrl: entryUrl(settings.entryFile),
        wrote: true,
      },
      null,
      2,
    )}\n`,
  )
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
