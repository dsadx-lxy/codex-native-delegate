import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderBlock, resolveSettings } from '../installer.mjs'

const TEST_BASE = path.dirname(fileURLToPath(import.meta.url))
const PREFIX = '.installer-config-'

async function fixture() {
  const dir = await fs.mkdtemp(path.join(TEST_BASE, PREFIX))
  const pluginRoot = path.join(dir, 'plugin-root')
  await fs.mkdir(path.join(pluginRoot, 'native', 'plugin'), { recursive: true })
  await fs.mkdir(path.join(dir, 'control'), { recursive: true })
  await fs.writeFile(path.join(pluginRoot, 'native.mjs'), 'export const ok = true\n', 'utf8')
  await fs.writeFile(path.join(pluginRoot, 'native', 'plugin', 'index.mjs'), 'export default {}\n', 'utf8')
  await fs.writeFile(path.join(dir, 'profile.yml'), '# profile\n', 'utf8')
  return { dir, pluginRoot }
}

async function removeFixture(dir) {
  const real = await fs.realpath(dir)
  assert.equal(path.dirname(real), path.resolve(TEST_BASE))
  assert.ok(path.basename(real).startsWith(PREFIX))
  await fs.rm(real, { recursive: true, force: true })
}

function args(values = {}) {
  return { flags: { apply: false, verify: false, versioned: false, help: false }, values }
}

test('portable settings resolve config paths without a fixed user or drive', async () => {
  const { dir, pluginRoot } = await fixture()
  try {
    const settings = await resolveSettings({
      args: args(),
      installerPath: path.join(dir, 'installer.mjs'),
      configDir: dir,
      config: {
        pluginRoot: 'plugin-root',
        entryFile: 'native.mjs',
        implementationDir: 'native/plugin',
        controlDir: '../control',
        controlRoot: '..',
        allowedRoot: '..',
        profilePath: 'profile.yml',
      },
      env: {},
    })
    assert.equal(settings.pluginRoot, pluginRoot)
    assert.equal(settings.entryFile, path.join(pluginRoot, 'native.mjs'))
    assert.equal(settings.implementationDir, path.join(pluginRoot, 'native', 'plugin'))
    assert.equal(settings.controlDir, path.join(dir, 'control'))
    assert.equal(settings.controlRoot, dir)
    assert.equal(settings.allowedRoot, dir)
    assert.equal(settings.profilePath, path.join(dir, 'profile.yml'))
    const block = renderBlock(settings)
    assert.match(block, /codex-native-delegate/)
    assert.ok(block.includes("name: 'file://"))
    assert.ok(block.includes(settings.controlDir.replaceAll('\\', '/')))
    assert.ok(block.includes(settings.allowedRoot.replaceAll('\\', '/')))
  } finally {
    await removeFixture(dir)
  }
})

test('explicit options override local config paths', async () => {
  const { dir, pluginRoot } = await fixture()
  try {
    const otherControl = path.join(dir, 'other-control')
    await fs.mkdir(otherControl, { recursive: true })
    const settings = await resolveSettings({
      args: args({ 'control-dir': otherControl }),
      installerPath: path.join(dir, 'installer.mjs'),
      configDir: dir,
      config: {
        pluginRoot: 'plugin-root',
        entryFile: 'native.mjs',
        implementationDir: 'native/plugin',
        controlDir: '../control',
        controlRoot: '..',
        allowedRoot: '..',
        profilePath: 'profile.yml',
      },
      env: {},
    })
    assert.equal(settings.controlDir, otherControl)
    assert.equal(settings.pluginRoot, pluginRoot)
  } finally {
    await removeFixture(dir)
  }
})

test('real junction/symlink escapes are rejected by realpath validation', async (t) => {
  const dir = await fs.mkdtemp(path.join(TEST_BASE, PREFIX))
  let junction = null
  try {
    const allowed = path.join(dir, 'allowed')
    const pluginRoot = path.join(allowed, 'plugin-root')
    const outside = path.join(dir, 'outside')
    await fs.mkdir(path.join(pluginRoot, 'native', 'plugin'), { recursive: true })
    await fs.mkdir(path.join(outside, 'plugin'), { recursive: true })
    await fs.mkdir(path.join(outside, 'records'), { recursive: true })
    await fs.mkdir(path.join(dir, 'control'), { recursive: true })
    await fs.writeFile(path.join(pluginRoot, 'native.mjs'), 'export const ok = true\n', 'utf8')
    await fs.writeFile(path.join(pluginRoot, 'native', 'plugin', 'index.mjs'), 'export default {}\n', 'utf8')
    await fs.writeFile(path.join(outside, 'plugin', 'index.mjs'), 'export default {}\n', 'utf8')
    await fs.writeFile(path.join(outside, 'entry.mjs'), 'export const outside = true\n', 'utf8')
    await fs.writeFile(path.join(dir, 'profile.yml'), '# profile\n', 'utf8')
    junction = path.join(pluginRoot, 'link-out')
    try {
      await fs.symlink(outside, junction, 'junction')
    } catch (error) {
      t.skip(`junction unavailable on this platform: ${error.code ?? String(error)}`)
      return
    }
    const base = {
      args: args(),
      installerPath: path.join(dir, 'installer.mjs'),
      configDir: dir,
      config: {
        pluginRoot: 'allowed/plugin-root',
        entryFile: 'native.mjs',
        implementationDir: 'native/plugin',
        controlDir: '../control',
        controlRoot: '..',
        allowedRoot: '..',
        profilePath: 'profile.yml',
      },
      env: {},
    }
    await assert.rejects(
      () => resolveSettings({ ...base, config: { ...base.config, implementationDir: 'link-out/plugin' } }),
      /implementation directory escapes its root via link or path/,
    )
    await assert.rejects(
      () => resolveSettings({ ...base, config: { ...base.config, entryFile: 'link-out/entry.mjs' } }),
      /entry file escapes its root via link or path/,
    )
    await assert.rejects(
      () => resolveSettings({ ...base, config: { ...base.config, controlDir: 'link-out/control' } }),
      /control directory escapes its root via link or path/,
    )
    await assert.rejects(
      () => resolveSettings({ ...base, config: { ...base.config, recordsDir: 'link-out/records' } }),
      /records directory escapes its root via link or path/,
    )
    await assert.rejects(
      () => resolveSettings({ ...base, config: { ...base.config, releasesDir: 'link-out/releases' } }),
      /releases directory escapes its root via link or path/,
    )
  } finally {
    if (junction) {
      await fs.rm(junction, { force: true }).catch(async () => {
        await fs.rmdir(junction).catch(() => {})
      })
    }
    await removeFixture(dir)
  }
})

test('out-of-bound implementation, entry, and control paths are rejected', async () => {
  const { dir } = await fixture()
  try {
    const base = {
      args: args(),
      installerPath: path.join(dir, 'installer.mjs'),
      configDir: dir,
      config: {
        pluginRoot: 'plugin-root',
        entryFile: 'native.mjs',
        implementationDir: 'native/plugin',
        controlDir: '../control',
        controlRoot: '..',
        allowedRoot: '..',
        profilePath: 'profile.yml',
      },
      env: {},
    }
    await assert.rejects(
      () => resolveSettings({ ...base, config: { ...base.config, implementationDir: '../outside' } }),
      /implementation directory must stay inside/,
    )
    await assert.rejects(
      () => resolveSettings({ ...base, config: { ...base.config, entryFile: '../outside.mjs' } }),
      /entry file must stay inside/,
    )
    await assert.rejects(
      () => resolveSettings({ ...base, config: { ...base.config, controlDir: '../..' } }),
      /control directory must stay inside/,
    )
    await assert.rejects(
      () => resolveSettings({ ...base, config: { ...base.config, controlRoot: '../..' } }),
      /control root must stay inside/,
    )
  } finally {
    await removeFixture(dir)
  }
})
