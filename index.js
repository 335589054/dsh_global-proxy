import { ECOSYSTEMS } from './src/catalog.js'
import { MirrorManager } from './src/manager.js'
import { createMirrorFetchTool, createMirrorTool, registerCommands, registerPrompt, registerShellEnv } from './src/surface.js'
import { errorMessage } from './src/util.js'

export const name = 'always-in-proxy'

// The tools registry is the one capability this plugin cannot work without.
// commands, systemPrompt, shellEnv, approval and web are all optional and are
// resolved through ctx.get() so older or smaller compositions still load.
export const inject = ['tools']

function log(ctx, level, message) {
  try {
    const logger = ctx?.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
    else if (level === 'warn') console.warn(message)
  } catch {
    // Logging must never break plugin activation.
  }
}

export function apply(ctx, config = {}) {
  const manager = new MirrorManager({ ctx, rawConfig: config })
  manager.ready = manager.ready.catch((error) => {
    log(ctx, 'warn', `always-in-proxy: state load failed, using defaults: ${errorMessage(error)}`)
    manager.refreshConfig()
  })

  ctx.effect(() => ctx.tools.register(createMirrorTool(ctx, manager)), 'always-in-proxy: mirror tool')

  const web = ctx.get('web')
  if (web) {
    ctx.effect(() => ctx.tools.register(createMirrorFetchTool(manager, web)), 'always-in-proxy: mirror_fetch tool')
  }

  registerCommands(ctx, manager)
  registerPrompt(ctx)
  registerShellEnv(ctx, manager)

  manager.ready.then(() => {
    if (manager.config.autoApply !== true) return
    manager.apply({ targets: [...ECOSYSTEMS] })
      .then((result) => log(ctx, 'info', `always-in-proxy: auto apply completed\n${result.text}`))
      .catch((error) => log(ctx, 'warn', `always-in-proxy: auto apply failed: ${errorMessage(error)}`))
  }).catch(() => {})
}
