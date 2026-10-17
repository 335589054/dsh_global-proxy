import path from 'node:path'
import { applyGit, applyNpm, applyPip, gitConfigPath, resetGit, restoreFileRecord } from './appliers.js'
import {
  DEFAULT_CONFIG,
  ECOSYSTEMS,
  ECOSYSTEM_LABEL,
  SourceCatalog,
  mergeConfig,
  normalizeSource,
  normalizeTargets
} from './catalog.js'
import { probeMany, probeSource, selectFastest } from './probe.js'
import { StateStore } from './state.js'
import {
  errorMessage,
  formatMs,
  hashText,
  readTextIfExists,
  userNpmrcPath,
  userPipConfigPath
} from './util.js'

const GITHUB_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'avatars.githubusercontent.com',
  'desktop.githubusercontent.com',
  'github-releases.githubusercontent.com'
])

function displayTargets(targets) {
  return targets.map((target) => ECOSYSTEM_LABEL[target] ?? target).join(', ')
}

function table(rows, columns) {
  const widths = columns.map((column) => Math.max(column.title.length, ...rows.map((row) => String(row[column.key] ?? '').length)))
  const header = columns.map((column, index) => column.title.padEnd(widths[index])).join('  ')
  const separator = widths.map((width) => '-'.repeat(width)).join('  ')
  const body = rows.map((row) => columns.map((column, index) => String(row[column.key] ?? '').padEnd(widths[index])).join('  '))
  return [header, separator, ...body].join('\n')
}

function measurementRow(measurement) {
  return {
    target: ECOSYSTEM_LABEL[measurement.ecosystem] ?? measurement.ecosystem,
    source: measurement.label ?? measurement.sourceId,
    ping: formatMs(measurement.ttfbMs),
    tcp: formatMs(measurement.tcpMs),
    tls: formatMs(measurement.tlsMs),
    status: measurement.status === 'ok' ? 'ok' : `fail${measurement.error ? `: ${measurement.error}` : ''}`
  }
}

function formatTest(groups) {
  const rows = []
  for (const group of groups) {
    for (const measurement of group.measurements) rows.push(measurementRow(measurement))
    if (group.error) rows.push({ target: ECOSYSTEM_LABEL[group.target] ?? group.target, source: '-', ping: '-', tcp: '-', tls: '-', status: `error: ${group.error}` })
  }
  return [
    table(rows, [
      { key: 'target', title: 'target' },
      { key: 'source', title: 'source' },
      { key: 'ping', title: 'ping/ttfb' },
      { key: 'tcp', title: 'tcp' },
      { key: 'tls', title: 'tls' },
      { key: 'status', title: 'status' }
    ]),
    '',
    '* application-layer latency, median of samples; not ICMP ping.'
  ].join('\n')
}

function formatApply(result) {
  const lines = ['Applied mirror sources:']
  for (const item of result.applied) {
    lines.push(`- ${ECOSYSTEM_LABEL[item.target] ?? item.target}: ${item.sourceLabel} (${item.sourceId})${item.changed ? '' : ' — already configured'}`)
    if (item.file) lines.push(`  ${item.file}`)
  }
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}

function formatReset(result) {
  const lines = result.results.length > 0 ? ['Restored mirror config:'] : ['Nothing to restore.']
  for (const item of result.results) {
    lines.push(`- ${ECOSYSTEM_LABEL[item.target] ?? item.target}: ${item.removed ? 'removed' : item.restored ? 'restored' : 'no change'}`)
    if (item.file) lines.push(`  ${item.file}`)
  }
  if (result.conflicts.length > 0) {
    lines.push('', 'Conflicts (left unchanged; use --force only if you accept overwriting edits):')
    for (const conflict of result.conflicts) lines.push(`- ${conflict}`)
  }
  return lines.join('\n')
}

export class MirrorManager {
  constructor({ ctx, rawConfig = {}, stateStore = new StateStore(), env = process.env, log, npmrcPath = userNpmrcPath(), pipConfigPath = userPipConfigPath() } = {}) {
    this.ctx = ctx
    this.rawConfig = rawConfig
    this.state = stateStore
    this.env = env
    this.npmrcPath = npmrcPath
    this.pipConfigPath = pipConfigPath
    this.log = log ?? ((level, message) => {
      const logger = ctx?.logger
      if (logger && typeof logger[level] === 'function') logger[level](message)
      else if (level === 'warn') console.warn(message)
    })
    this.backupRoot = stateStore.backupRoot
    this.config = mergeConfig(DEFAULT_CONFIG, rawConfig)
    this.catalog = new SourceCatalog({ customSources: [], config: this.config })
    this.lock = Promise.resolve()
    this.ready = this.init()
  }

  async init() {
    await this.state.load()
    this.refreshConfig()
  }

  refreshConfig() {
    this.config = mergeConfig(DEFAULT_CONFIG, this.rawConfig, this.state.settings)
    try {
      this.catalog = new SourceCatalog({ customSources: this.state.customSources, config: this.config })
    } catch (error) {
      this.log('warn', `always-in-proxy: invalid custom sources ignored: ${errorMessage(error)}`)
      this.catalog = new SourceCatalog({ customSources: [], config: this.config })
    }
  }

  async serialize(operation) {
    const previous = this.lock
    let release
    this.lock = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      await this.ready
      return await operation()
    } finally {
      release()
    }
  }

  sourceOrThrow(id) {
    const source = this.catalog.get(id)
    if (!source) throw new Error(`unknown source: ${id}`)
    return source
  }

  enabledTargets(requested) {
    const normalized = normalizeTargets(requested)
    const targets = normalized.filter((target) => this.config.targets[target] !== false)
    if (targets.length === 0) throw new Error(`no enabled target in: ${normalized.join(', ')}`)
    return targets
  }

  probeOptions() {
    return {
      samples: this.config.probe.samples,
      timeoutMs: this.config.probe.timeoutMs,
      concurrency: this.config.probe.concurrency,
      allowPrivateHosts: this.config.safety.allowPrivateHosts === true,
      allowInsecure: this.config.safety.allowInsecure === true
    }
  }

  async measureTarget(target) {
    const sources = this.catalog.forEcosystem(target)
    if (sources.length === 0) throw new Error(`no sources configured for ${target}`)
    return probeMany(sources, this.probeOptions())
  }

  async chooseSource(target, selections) {
    const explicit = selections?.[target]
    if (explicit) {
      const source = this.sourceOrThrow(explicit)
      if (source.ecosystem !== target) throw new Error(`source ${explicit} is for ${source.ecosystem}, not ${target}`)
      const measurement = await probeSource(source, this.probeOptions())
      if (measurement.status !== 'ok') throw new Error(`source ${explicit} is not reachable: ${measurement.error ?? 'probe failed'}`)
      return { source, measurement, warnings: [] }
    }

    const warnings = []
    if (this.config.strategy === 'manual') {
      const manualId = this.config.manual?.[target]
      const manual = manualId ? this.catalog.get(manualId) : undefined
      if (manual && manual.ecosystem === target) {
        const measurement = await probeSource(manual, this.probeOptions())
        if (measurement.status === 'ok') return { source: manual, measurement, warnings }
        warnings.push(`manual source ${manual.id} failed (${measurement.error ?? 'probe failed'}); falling back to fastest`)
      } else if (manualId) {
        warnings.push(`manual source ${manualId} is unavailable; falling back to fastest`)
      }
    }

    const measurements = await this.measureTarget(target)
    const fastest = selectFastest(measurements)
    if (!fastest) {
      const errors = measurements.filter((measurement) => measurement.error).map((measurement) => `${measurement.sourceId}: ${measurement.error}`)
      throw new Error(`no healthy source for ${target}${errors.length > 0 ? ` (${errors.join('; ')})` : ''}`)
    }
    const source = this.catalog.get(fastest.sourceId)
    if (!source) throw new Error(`selected source disappeared: ${fastest.sourceId}`)
    return { source, measurement: fastest, warnings }
  }

  async test({ targets, refresh = true } = {}) {
    return this.serialize(async () => {
      const selected = this.enabledTargets(targets)
      const groups = []
      for (const target of selected) {
        try {
          const measurements = await this.measureTarget(target)
          groups.push({ target, measurements })
          await this.state.setLastProbe(target, measurements)
        } catch (error) {
          groups.push({ target, measurements: [], error: errorMessage(error) })
        }
      }
      await this.state.save()
      return { text: formatTest(groups), groups, refreshed: refresh }
    })
  }

  async status() {
    return this.serialize(async () => {
      const lines = [
        'always-in-proxy',
        `  enabled: ${this.config.enabled}`,
        `  strategy: ${this.config.strategy}`,
        `  targets: ${displayTargets(ECOSYSTEMS.filter((target) => this.config.targets[target] !== false))}`,
        `  autoApply: ${this.config.autoApply}`,
        ''
      ]
      for (const target of ECOSYSTEMS) {
        const applied = this.state.applied[target]
        const source = applied?.sourceId ? this.catalog.get(applied.sourceId) : undefined
        lines.push(`  ${target}: ${applied ? `${source?.label ?? applied.sourceId} (${applied.sourceId})` : 'not applied'}`)
        if (applied?.file) lines.push(`    ${applied.file}`)
      }
      const warnings = []
      if (this.env.PIP_INDEX_URL) warnings.push('PIP_INDEX_URL is set and overrides the pip config')
      if (this.env.NPM_CONFIG_REGISTRY || this.env.npm_config_registry) warnings.push('NPM_CONFIG_REGISTRY/npm_config_registry is set and overrides .npmrc')
      if (this.config.strategy === 'manual') {
        const missing = ECOSYSTEMS.filter((target) => !this.config.manual?.[target])
        if (missing.length > 0) warnings.push(`manual strategy has no source for: ${missing.join(', ')}`)
      }
      if (warnings.length > 0) {
        lines.push('', '  warnings:')
        for (const warning of warnings) lines.push(`    - ${warning}`)
      }
      return { text: lines.join('\n'), warnings }
    })
  }

  async sources() {
    return this.serialize(async () => {
      const rows = this.catalog.list().map((source) => ({
        id: source.id,
        ecosystem: source.ecosystem,
        label: source.label,
        url: source.baseUrl,
        kind: source.builtin ? 'builtin' : 'custom'
      }))
      return {
        text: table(rows, [
          { key: 'id', title: 'id' },
          { key: 'ecosystem', title: 'target' },
          { key: 'label', title: 'label' },
          { key: 'kind', title: 'kind' },
          { key: 'url', title: 'baseUrl' }
        ]),
        sources: rows
      }
    })
  }

  async apply({ targets, selections = {}, dryRun = false } = {}) {
    return this.serialize(async () => {
      if (!this.config.enabled) throw new Error('always-in-proxy is disabled; run /mirror enable first')
      const selected = this.enabledTargets(targets)
      const plans = []
      const warnings = []
      for (const target of selected) {
        const chosen = await this.chooseSource(target, selections)
        warnings.push(...chosen.warnings)
        plans.push({ target, ...chosen })
      }

      if (dryRun) {
        const lines = ['Dry run — no files changed.', '']
        for (const plan of plans) {
          lines.push(`- ${ECOSYSTEM_LABEL[plan.target]}: ${plan.source.label} (${plan.source.id}), ${formatMs(plan.measurement.ttfbMs)}`)
        }
        if (warnings.length > 0) lines.push('', 'Warnings:', ...warnings.map((warning) => `- ${warning}`))
        return { text: lines.join('\n'), plans, dryRun: true }
      }

      const applied = []
      try {
        for (const plan of plans) {
          let record
          if (plan.target === 'github') {
            record = await applyGit(plan.source, { env: this.env })
          } else if (plan.target === 'npm') {
            record = await applyNpm(plan.source, { backupDir: path.join(this.backupRoot, String(Date.now())), file: this.npmrcPath })
          } else {
            record = await applyPip(plan.source, { backupDir: path.join(this.backupRoot, String(Date.now())), file: this.pipConfigPath })
          }
          applied.push({ target: plan.target, record, source: plan.source, measurement: plan.measurement })
          await this.state.setApplied(plan.target, record)
        }
        await this.state.save()
      } catch (error) {
        const rollbackErrors = []
        for (const item of [...applied].reverse()) {
          try {
            if (item.target === 'github') await resetGit(item.record, { env: this.env, force: true })
            else if (item.record.changed !== false) await restoreFileRecord(item.record, { force: true })
            await this.state.clearApplied(item.target)
          } catch (rollbackError) {
            rollbackErrors.push(`${item.target}: ${errorMessage(rollbackError)}`)
          }
        }
        await this.state.save().catch(() => {})
        const suffix = rollbackErrors.length > 0 ? `; rollback issues: ${rollbackErrors.join('; ')}` : ''
        throw new Error(`apply failed: ${errorMessage(error)}${suffix}`)
      }

      const summary = applied.map((item) => ({
        target: item.target,
        sourceId: item.source.id,
        sourceLabel: item.source.label,
        changed: item.record.changed !== false,
        file: item.record.file
      }))
      return { text: formatApply({ applied: summary, warnings }), applied: summary, warnings }
    })
  }

  async reset({ targets, force = false } = {}) {
    return this.serialize(async () => {
      const requested = targets === undefined || targets === null || targets === 'all'
        ? Object.keys(this.state.applied)
        : normalizeTargets(targets).filter((target) => target in this.state.applied)
      if (requested.length === 0) return { text: 'Nothing to restore.', results: [], conflicts: [] }
      const results = []
      const conflicts = []
      for (const target of requested) {
        const record = this.state.applied[target]
        try {
          let restored
          if (target === 'github') {
            restored = await resetGit(record, { env: this.env, force })
          } else if (record.changed === false) {
            restored = { target, file: record.file, restored: true, removed: false }
          } else {
            restored = await restoreFileRecord(record, { force })
          }
          results.push(restored)
          await this.state.clearApplied(target)
        } catch (error) {
          conflicts.push(`${ECOSYSTEM_LABEL[target] ?? target}: ${errorMessage(error)}`)
        }
      }
      await this.state.save()
      return { text: formatReset({ results, conflicts }), results, conflicts }
    })
  }

  async use(target, sourceId) {
    return this.serialize(async () => {
      const source = this.sourceOrThrow(sourceId)
      if (source.ecosystem !== target) throw new Error(`source ${sourceId} belongs to ${source.ecosystem}, not ${target}`)
      await this.state.updateSettings({ strategy: 'manual', manual: { ...this.config.manual, [target]: sourceId } })
      this.refreshConfig()
    }).then(() => this.apply({ targets: [target], selections: { [target]: sourceId } }))
  }

  async setStrategy(strategy) {
    if (!['fastest', 'manual'].includes(strategy)) throw new Error('strategy must be fastest or manual')
    return this.serialize(async () => {
      await this.state.updateSettings({ strategy })
      this.refreshConfig()
      return strategy
    })
  }

  async setEnabled(enabled) {
    return this.serialize(async () => {
      await this.state.updateSettings({ enabled: Boolean(enabled) })
      this.refreshConfig()
      return this.config.enabled
    })
  }

  async addSource(raw) {
    return this.serialize(async () => {
      const source = normalizeSource(raw, this.config)
      if (this.catalog.get(source.id)) throw new Error(`source id already exists: ${source.id}`)
      const candidate = new SourceCatalog({ customSources: [...this.state.customSources, source], config: this.config })
      this.catalog = candidate
      await this.state.addSource(source)
      return source
    })
  }

  async removeSource(id) {
    return this.serialize(async () => {
      const source = this.catalog.get(id)
      if (!source) throw new Error(`unknown source: ${id}`)
      if (source.builtin) throw new Error('builtin sources cannot be removed')
      await this.state.removeSource(id)
      this.refreshConfig()
      return source
    })
  }

  shellFactsSync() {
    const applied = this.state.applied
    const value = (target) => applied[target]?.sourceId ?? 'unset'
    return {
      DSH_MIRROR_GITHUB: value('github'),
      DSH_MIRROR_NPM: value('npm'),
      DSH_MIRROR_PIP: value('pip'),
      DSH_MIRROR_ACTIVE: Object.keys(applied).length > 0 ? '1' : '0'
    }
  }

  async shellFacts() {
    await this.ready.catch(() => {})
    return this.shellFactsSync()
  }

  githubSource() {
    const appliedId = this.state.applied.github?.sourceId
    const configured = appliedId ? this.catalog.get(appliedId) : undefined
    return configured ??
      this.catalog.get(this.config.manual?.github) ??
      this.catalog.defaultFor('github')
  }

  rewriteGithubUrl(rawUrl) {
    let url
    try {
      url = new URL(String(rawUrl))
    } catch {
      throw new Error('invalid URL')
    }
    if (url.protocol !== 'https:') throw new Error('only https URLs are supported')
    if (url.username || url.password) throw new Error('URLs with credentials are not supported')
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) throw new Error(`not a supported GitHub host: ${url.hostname}`)
    const source = this.githubSource()
    if (!source) throw new Error('no GitHub mirror configured')
    const prefix = source.baseUrl.endsWith('/') ? source.baseUrl : `${source.baseUrl}/`
    if (url.toString().startsWith(prefix)) return { url: url.toString(), source }
    return { url: `${prefix}${url.toString()}`, source }
  }
}
