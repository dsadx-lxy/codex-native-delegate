#!/usr/bin/env node
// Stable native entry for all Codex conversations.
//
// Two supported modes:
// - Desktop imports this file as an ESM plugin; only the plugin exports are
//   evaluated and no CLI code runs.
// - `node native.mjs doctor|start|status|...` runs the project CLI.
//
// The implementation lives in ./native/; this file stays tiny and is the one
// durable URL the Desktop profile references.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export { default, name, version, apply } from './native/plugin/index.mjs'

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null
const thisPath = fileURLToPath(import.meta.url)

if (invokedPath !== null && invokedPath === path.resolve(thisPath)) {
  try {
    const { main } = await import('./native/cli/codex-delegate.mjs')
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
