import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = path.join(root, '.test-tmp')
await fs.mkdir(temp, { recursive: true })
const tests = (await fs.readdir(path.join(root, 'test'))).filter(n => n.endsWith('.test.mjs')).sort().map(n => path.join(root, 'test', n))
const child = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', env: { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp } })
if (child.error) throw child.error
process.exitCode = child.status ?? 1
