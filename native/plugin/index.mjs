// Cordis plugin entry. It exports the functional plugin shape that the
// Cordis loader unwraps from an ESM namespace: `apply(ctx, config)`.
//
// The plugin is intentionally dependency-free at import time. It resolves every
// Host capability through `ctx.get` / `ctx.inject`, so it can be loaded from an
// absolute file:// URL without a node_modules base inside the Desktop profile.

import path from 'node:path'
import { atomicWriteJson, controlLayout, ensureLayout, nowIso } from './lib/store.mjs'
import { REQUIRED_SERVICES, validatePluginConfig } from './lib/policy.mjs'
import { DelegationRuntime } from './runtime.mjs'

export const name = 'codex-native-delegate'
export const version = '0.2.1'

export function apply(ctx, rawConfig) {
  let config
  try {
    config = validatePluginConfig(rawConfig)
  } catch (error) {
    // Invalid configuration must not create files outside the authorized root.
    ctx.logger?.error?.(`[codex-native-delegate] invalid config: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }

  const layout = controlLayout(config.controlDir)
  const hasService = (service) => {
    try {
      return ctx.get(service) !== undefined
    } catch {
      return false
    }
  }
  const missing = () => REQUIRED_SERVICES.filter((service) => !hasService(service))
  let waitingTimer
  let runtime

  const reportWaiting = async (lastError = null) => {
    try {
      await ensureLayout(config.controlDir)
      await atomicWriteJson(layout.host, {
        schema: 1,
        pluginVersion: version,
        hostId: null,
        pid: process.pid,
        state: lastError === null ? 'starting' : 'error',
        startedAt: nowIso(),
        updatedAt: nowIso(),
        missingServices: missing(),
        config: {
          controlDir: config.controlDir,
          controlRoot: config.controlRoot,
          allowedRoot: config.allowedRoot,
          agentPreset: config.agentPreset,
          permissionPreset: config.permissionPreset ?? null,
          decisionTimeoutMs: config.decisionTimeoutMs,
        },
        ...(lastError === null ? {} : { lastError }),
      })
    } catch (error) {
      ctx.logger?.warn?.(`[codex-native-delegate] cannot write waiting status: ${String(error)}`)
    }
  }

  void reportWaiting()
  waitingTimer = setInterval(() => {
    if (runtime) return
    void reportWaiting()
  }, 3000)
  waitingTimer.unref?.()

  ctx.effect(() => () => {
    if (waitingTimer) clearInterval(waitingTimer)
  }, 'codex-native-delegate.waiting-status')

  ctx.inject(REQUIRED_SERVICES, (scope) => {
    if (waitingTimer) clearInterval(waitingTimer)
    if (runtime) return
    const instance = new DelegationRuntime(scope, config)
    runtime = instance
    scope.effect(() => {
      const startPromise = instance.start().catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error)
        scope.logger?.error?.(`[codex-native-delegate] start failed: ${message}`)
        await instance.writeHost('error', { lastError: message }).catch(() => {})
      })
      return async () => {
        // Cordis must be able to await teardown before a replacement instance
        // starts. Await the start attempt, then shutdown even when start failed.
        await startPromise.catch(() => {})
        try {
          await instance.shutdown()
        } catch (error) {
          scope.logger?.warn?.(
            `[codex-native-delegate] shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        } finally {
          if (runtime === instance) runtime = undefined
        }
      }
    }, 'codex-native-delegate.runtime')
  })

  ctx.logger?.info?.(
    `[codex-native-delegate] loaded; waiting for ${missing().length ? missing().join(', ') : 'no missing services'}; control=${path.resolve(config.controlDir)}`,
  )
}

export default { name, version, apply }
