import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { planVersionedRelease, safeInstallProfile, stageVersionedRelease } from '../installer.mjs'

const TEST_BASE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_BASE, '..')
const PACKAGE_LAYOUT = fsSync.existsSync(path.join(REPO_ROOT, 'native', 'plugin'))
const PREFIX = '.installer-test-'
const STAGE_SETTINGS = {
  pluginRoot: PACKAGE_LAYOUT ? REPO_ROOT : path.resolve(REPO_ROOT, '..'),
  implementationDir: PACKAGE_LAYOUT ? path.join(REPO_ROOT, 'native', 'plugin') : path.join(REPO_ROOT, 'plugin'),
}

async function sample() {
  const dir = await fs.mkdtemp(path.join(TEST_BASE, PREFIX))
  const file = path.join(dir, 'cordis.patch.yml')
  const original = '# original profile\n- id: one\n  name: "@example/one"\n'
  const installed = `${original}\n# inserted\n- insert:\n    - id: codex-native-delegate\n      name: "file:///sample"\n`
  await fs.writeFile(file, original, 'utf8')
  return { dir, file, original, installed }
}

async function removeSample(dir) {
  const real = await fs.realpath(dir)
  assert.equal(path.dirname(real), path.resolve(TEST_BASE))
  assert.ok(path.basename(real).startsWith(PREFIX))
  await fs.rm(real, { recursive: true, force: true })
}

test('safe profile replacement preserves original lines and verifies the new fragment', async () => {
  const { dir, file, original, installed } = await sample()
  try {
    const result = await safeInstallProfile({
      file,
      originalText: original,
      installedText: installed,
      backupPath: null,
    })
    assert.equal(await fs.readFile(file, 'utf8'), installed)
    assert.match(result.profileSha256, /^[a-f0-9]{64}$/)
  } finally {
    await removeSample(dir)
  }
})

test('a refused Windows replace leaves the existing profile unchanged', async () => {
  const { dir, file, original, installed } = await sample()
  try {
    const ops = {
      ...fs,
      async rename() {
        const error = new Error('locked profile')
        error.code = 'EPERM'
        throw error
      },
    }
    await assert.rejects(
      () => safeInstallProfile({ file, originalText: original, installedText: installed, backupPath: null, ops }),
      /original profile left unchanged/,
    )
    assert.equal(await fs.readFile(file, 'utf8'), original)
  } finally {
    await removeSample(dir)
  }
})

test('a refused replace that finds the profile missing restores the original text', async () => {
  const { dir, file, original, installed } = await sample()
  try {
    const ops = {
      ...fs,
      async rename() {
        await fs.rm(file, { force: true })
        const error = new Error('replace failed after target vanished')
        error.code = 'EPERM'
        throw error
      },
    }
    await assert.rejects(
      () => safeInstallProfile({ file, originalText: original, installedText: installed, backupPath: null, ops }),
      /restored from backup/,
    )
    assert.equal(await fs.readFile(file, 'utf8'), original)
  } finally {
    await removeSample(dir)
  }
})

test('post-write verification failure restores the pre-install profile', async () => {
  const { dir, file, original, installed } = await sample()
  try {
    const ops = {
      ...fs,
      async rename(from, to) {
        await fs.rename(from, to)
        await fs.writeFile(to, 'corrupted by injected fault', 'utf8')
      },
    }
    await assert.rejects(
      () => safeInstallProfile({ file, originalText: original, installedText: installed, backupPath: null, ops }),
      /verification failed; original profile restored/,
    )
    assert.equal(await fs.readFile(file, 'utf8'), original)
  } finally {
    await removeSample(dir)
  }
})

test('versioned release staging copies a complete isolated plugin graph', async () => {
  const dir = await fs.mkdtemp(path.join(TEST_BASE, PREFIX))
  const releasesDir = path.join(dir, 'releases')
  try {
    const plan = await planVersionedRelease(STAGE_SETTINGS, { releasesDir })
    assert.match(plan.releaseId, /^release-[a-f0-9]{16}$/)
    assert.equal(await fs.stat(plan.releaseDir).then(() => true, () => false), false, 'plan writes nothing')

    const staged = await stageVersionedRelease(STAGE_SETTINGS, { releasesDir })
    assert.equal(staged.created, true)
    const manifest = JSON.parse(await fs.readFile(path.join(staged.releaseDir, 'release.json'), 'utf8'))
    assert.equal(manifest.pluginAggregateSha256, plan.graph.aggregateSha256)
    for (const file of manifest.files) {
      const target = path.join(staged.releaseDir, ...file.path.split('/'))
      const text = await fs.readFile(target)
      assert.equal(
        crypto.createHash('sha256').update(text).digest('hex'),
        file.sha256,
        `copied hash ${file.path}`,
      )
    }
    const entryText = await fs.readFile(staged.entryPath, 'utf8')
    assert.match(entryText, /from '\.\/plugin\/index\.mjs'/)
    const second = await stageVersionedRelease(STAGE_SETTINGS, { releasesDir })
    assert.equal(second.created, false, 'same graph reuses the release')
    assert.equal(second.releaseId, staged.releaseId)
  } finally {
    await removeSample(dir)
  }
})

test('backup is used when in-place restoration cannot write the profile', async () => {
  const { dir, file, original, installed } = await sample()
  const backupPath = path.join(dir, 'profile.backup.yml')
  await fs.writeFile(backupPath, original, 'utf8')
  try {
    const ops = {
      ...fs,
      async rename() {
        await fs.rm(file, { force: true })
        const error = new Error('replace failed')
        error.code = 'EPERM'
        throw error
      },
      async writeFile(target, data, options) {
        if (target === file && data === original) {
          const error = new Error('cannot write profile')
          error.code = 'EPERM'
          throw error
        }
        return await fs.writeFile(target, data, options)
      },
    }
    await assert.rejects(
      () => safeInstallProfile({ file, originalText: original, installedText: installed, backupPath, ops }),
      /restored from backup/,
    )
    assert.equal(await fs.readFile(file, 'utf8'), original)
  } finally {
    await removeSample(dir)
  }
})
