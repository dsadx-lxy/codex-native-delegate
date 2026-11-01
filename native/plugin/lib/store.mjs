// Shared filesystem helpers for the native Codex delegation prototype.
// No third-party imports: this file must load from a bare file:// URL inside
// the Desktop Host without a node_modules resolution base.

import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const SCHEMA = 1

export function nowIso() {
  return new Date().toISOString()
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

export function safeId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError(`${label} is not a safe identifier`)
  }
  return value
}

export function shortHash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

export function controlLayout(controlDir) {
  const root = path.resolve(controlDir)
  return {
    root,
    tasks: path.join(root, 'tasks'),
    commands: path.join(root, 'commands'),
    commandsProcessed: path.join(root, 'commands', 'processed'),
    commandResults: path.join(root, 'commands', 'results'),
    commandInvalid: path.join(root, 'commands', 'invalid'),
    approvals: path.join(root, 'approvals'),
    approvalsResolved: path.join(root, 'approvals', 'resolved'),
    decisions: path.join(root, 'decisions'),
    decisionsConsumed: path.join(root, 'decisions', 'consumed'),
    decisionsInvalid: path.join(root, 'decisions', 'invalid'),
    events: path.join(root, 'events'),
    outputs: path.join(root, 'outputs'),
    reviews: path.join(root, 'reviews'),
    host: path.join(root, 'host.json'),
  }
}

export async function ensureLayout(controlDir) {
  const layout = controlLayout(controlDir)
  for (const dir of [
    layout.root,
    layout.tasks,
    layout.commands,
    layout.commandsProcessed,
    layout.commandResults,
    layout.commandInvalid,
    layout.approvals,
    layout.approvalsResolved,
    layout.decisions,
    layout.decisionsConsumed,
    layout.decisionsInvalid,
    layout.events,
    layout.outputs,
    layout.reviews,
  ]) {
    await fs.mkdir(dir, { recursive: true })
  }
  return layout
}

export async function readJson(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new Error(`cannot read JSON ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export async function atomicWriteJson(file, value, options = {}) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (options.exclusive) {
    await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' })
    return file
  }
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomUUID()}.json`)
  await fs.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' })
  try {
    await fs.rename(tmp, file)
  } catch (error) {
    // Windows can refuse a replace while another reader holds the target.
    // Keep the write atomic from the reader's point of view by replacing it
    // only after the fallback removal succeeds.
    if (error && (error.code === 'EPERM' || error.code === 'EEXIST' || error.code === 'EACCES')) {
      await fs.rm(file, { force: true })
      await fs.rename(tmp, file)
    } else {
      await fs.rm(tmp, { force: true })
      throw error
    }
  }
  return file
}

export async function listJson(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.tmp-'))
    .map((entry) => path.join(dir, entry.name))
    .sort()
  const out = []
  for (const file of files) {
    try {
      const value = await readJson(file)
      if (value !== null) out.push({ file, value })
    } catch {
      // A corrupt queue file must be visible to the caller rather than abort
      // every other pending item; expose the path with a null value.
      out.push({ file, value: null })
    }
  }
  return out
}

export async function moveInto(file, dir, name = path.basename(file)) {
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, name)
  try {
    await fs.rename(file, target)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    if (error && (error.code === 'EPERM' || error.code === 'EEXIST' || error.code === 'EACCES')) {
      await fs.rm(target, { force: true })
      await fs.rename(file, target)
    } else {
      throw error
    }
  }
  return target
}

export async function appendJsonl(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

export function hostIsFresh(host, maxAgeMs = 15000) {
  if (!host || typeof host.updatedAt !== 'string') return false
  const updated = Date.parse(host.updatedAt)
  if (!Number.isFinite(updated)) return false
  return Date.now() - updated <= maxAgeMs && (host.state === 'ready' || host.state === 'starting')
}

export function jsonByteSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Infinity
  }
}

export function capJson(value, maxChars = 16000) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return { truncated: true, note: 'unserializable value' }
  }
  if (text.length <= maxChars) return value
  return { truncated: true, originalChars: text.length, preview: text.slice(0, maxChars) }
}

export default {
  SCHEMA,
  appendJsonl,
  atomicWriteJson,
  capJson,
  controlLayout,
  ensureLayout,
  hostIsFresh,
  isProcessAlive,
  jsonByteSize,
  listJson,
  moveInto,
  newId,
  nowIso,
  readJson,
  safeId,
  shortHash,
}
