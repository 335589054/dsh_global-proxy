import { mergePlain } from './util.js'

export const ECOSYSTEMS = ['github', 'npm', 'pip']

export const ECOSYSTEM_LABEL = {
  github: 'GitHub',
  npm: 'npm/pnpm',
  pip: 'PyPI/pip'
}

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  strategy: 'fastest',
  autoApply: false,
  targets: { github: true, npm: true, pip: true },
  manual: {
    github: 'github-ghproxy',
    npm: 'npm-npmmirror',
    pip: 'pip-tuna'
  },
  probe: {
    samples: 3,
    timeoutMs: 3000,
    ttlMs: 300000,
    concurrency: 4
  },
  safety: {
    requireApproval: true,
    allowPrivateHosts: false,
    backupKeep: 10
  }
})

export const BUILTIN_SOURCES = Object.freeze([
  Object.freeze({
    id: 'github-ghproxy',
    label: 'gh-proxy.org',
    ecosystem: 'github',
    kind: 'github-prefix',
    baseUrl: 'https://gh-proxy.org/',
    priority: 100,
    builtin: true
  }),
  Object.freeze({
    id: 'npm-npmmirror',
    label: 'npmmirror',
    ecosystem: 'npm',
    kind: 'npm-registry',
    baseUrl: 'https://registry.npmmirror.com',
    priority: 100,
    builtin: true
  }),
  Object.freeze({
    id: 'pip-tuna',
    label: '清华 TUNA',
    ecosystem: 'pip',
    kind: 'pypi-index',
    baseUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    priority: 100,
    builtin: true
  })
])

const KIND_BY_ECOSYSTEM = {
  github: 'github-prefix',
  npm: 'npm-registry',
  pip: 'pypi-index'
}

export function mergeConfig(...layers) {
  return layers.reduce((current, layer) => mergePlain(current, layer ?? {}), DEFAULT_CONFIG)
}

export function normalizeTargets(rawTargets) {
  if (rawTargets === undefined || rawTargets === null) return [...ECOSYSTEMS]
  if (!Array.isArray(rawTargets)) throw new Error('targets must be an array')
  const targets = rawTargets.map(String)
  for (const target of targets) {
    if (!ECOSYSTEMS.includes(target)) throw new Error(`unsupported target: ${target}`)
  }
  return [...new Set(targets)]
}

function normalizeUrl(value, { allowInsecure = false } = {}) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error(`invalid URL: ${value}`)
  }
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed')
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new Error(`only https URLs are allowed: ${url.origin}`)
  }
  url.hash = ''
  url.search = ''
  return url
}

export function normalizeBaseUrl(value, ecosystem, options = {}) {
  const url = normalizeUrl(value, options)
  let pathname = url.pathname
  if (ecosystem === 'github') {
    if (!pathname.endsWith('/')) pathname += '/'
  } else {
    pathname = pathname.replace(/\/+$/, '')
  }
  return `${url.origin}${pathname}`
}

export function defaultProbeUrl(source) {
  if (source.ecosystem === 'github') {
    return `${source.baseUrl}https://raw.githubusercontent.com/octocat/Hello-World/master/README`
  }
  if (source.ecosystem === 'npm') {
    return `${source.baseUrl}/-/ping`
  }
  const base = source.baseUrl.replace(/\/+$/, '')
  return base.endsWith('/simple') ? `${base}/pip/` : `${base}/simple/pip/`
}

export function normalizeSource(raw, config = DEFAULT_CONFIG) {
  if (!raw || typeof raw !== 'object') throw new Error('source must be an object')
  const id = String(raw.id ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) {
    throw new Error('source id must match [a-z0-9][a-z0-9-]{1,40}')
  }
  const ecosystem = String(raw.ecosystem ?? '').trim().toLowerCase()
  if (!ECOSYSTEMS.includes(ecosystem)) throw new Error(`unsupported ecosystem: ${raw.ecosystem}`)
  const kind = String(raw.kind ?? KIND_BY_ECOSYSTEM[ecosystem]).trim()
  if (kind !== KIND_BY_ECOSYSTEM[ecosystem]) {
    throw new Error(`source kind ${kind} does not match ecosystem ${ecosystem}`)
  }
  const allowInsecure = config?.safety?.allowInsecure === true
  const baseUrl = normalizeBaseUrl(raw.baseUrl, ecosystem, { allowInsecure })
  let probeUrl
  if (raw.probeUrl !== undefined && raw.probeUrl !== '') {
    probeUrl = normalizeUrl(raw.probeUrl, { allowInsecure }).toString()
  }
  const source = {
    id,
    label: String(raw.label ?? new URL(baseUrl).hostname).trim() || new URL(baseUrl).hostname,
    ecosystem,
    kind,
    baseUrl,
    priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 100,
    builtin: false,
    enabled: raw.enabled !== false,
    ...(probeUrl ? { probeUrl } : {})
  }
  return Object.freeze(source)
}

export class SourceCatalog {
  constructor({ customSources = [], config = DEFAULT_CONFIG } = {}) {
    this.config = config
    this.custom = []
    const ids = new Set(BUILTIN_SOURCES.map((source) => source.id))
    for (const raw of customSources) {
      const source = normalizeSource(raw, config)
      if (ids.has(source.id)) throw new Error(`source id already exists: ${source.id}`)
      ids.add(source.id)
      this.custom.push(source)
    }
  }

  list() {
    return [...BUILTIN_SOURCES.map((source) => ({ ...source, enabled: true })), ...this.custom]
  }

  forEcosystem(ecosystem) {
    return this.list().filter((source) => source.ecosystem === ecosystem && source.enabled !== false)
  }

  get(id) {
    return this.list().find((source) => source.id === id)
  }

  defaultFor(ecosystem) {
    return this.forEcosystem(ecosystem)[0]
  }
}
