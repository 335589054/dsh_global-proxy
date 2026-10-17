import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { performance } from 'node:perf_hooks'
import { defaultProbeUrl } from './catalog.js'
import { errorMessage, median } from './util.js'

const USER_AGENT = 'always-in-proxy/0.1 (+https://github.com/deepseek-ai)'

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
}

function isPrivateIpv6(address) {
  const value = address.toLowerCase().split('%')[0]
  if (value === '::' || value === '::1') return true
  if (value.startsWith('::ffff:')) return isPrivateIpv4(value.slice(7))
  if (value.startsWith('fc') || value.startsWith('fd')) return true
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true
  if (value.startsWith('2001:db8:')) return true
  return false
}

export function isPrivateAddress(address) {
  const family = net.isIP(address)
  if (family === 4) return isPrivateIpv4(address)
  if (family === 6) return isPrivateIpv6(address)
  return true
}

function assertSafeHostname(hostname, allowPrivateHosts) {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (value === 'localhost' || value.endsWith('.localhost')) {
    if (!allowPrivateHosts) throw new Error(`refusing private host: ${hostname}`)
  }
}

async function resolveAddresses(hostname, { allowPrivateHosts }) {
  assertSafeHostname(hostname, allowPrivateHosts)
  const literal = net.isIP(hostname.replace(/^\[|\]$/g, ''))
  if (literal) {
    const address = hostname.replace(/^\[|\]$/g, '')
    if (!allowPrivateHosts && isPrivateAddress(address)) throw new Error(`refusing private address: ${address}`)
    return [{ address, family: literal }]
  }
  const started = performance.now()
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  const dnsMs = performance.now() - started
  if (addresses.length === 0) throw new Error(`no DNS answer for ${hostname}`)
  if (!allowPrivateHosts) {
    const blocked = addresses.find((entry) => isPrivateAddress(entry.address))
    if (blocked) throw new Error(`refusing private DNS answer: ${blocked.address}`)
  }
  return addresses.map((entry) => ({ ...entry, dnsMs }))
}

function requestOnce(url, { timeoutMs, allowPrivateHosts, method = 'HEAD', address }) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    let settled = false
    let tcpMs
    let tlsMs
    let deadline

    const finish = (value) => {
      if (settled) return
      settled = true
      if (deadline) clearTimeout(deadline)
      resolve(value)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      if (deadline) clearTimeout(deadline)
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method,
      agent: false,
      headers: {
        'user-agent': USER_AGENT,
        accept: '*/*',
        ...(method === 'GET' ? { range: 'bytes=0-0' } : {})
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all === true) callback(null, [{ address: address.address, family: address.family }])
        else callback(null, address.address, address.family)
      }
    }, (response) => {
      const ttfbMs = performance.now() - started
      const statusCode = response.statusCode ?? 0
      response.destroy()
      if (method === 'HEAD' && (statusCode === 405 || statusCode === 501)) {
        requestOnce(url, { timeoutMs, allowPrivateHosts, method: 'GET', address }).then(finish, fail)
        return
      }
      finish({
        ok: statusCode >= 200 && statusCode < 400,
        statusCode,
        dnsMs: address.dnsMs,
        tcpMs,
        tlsMs,
        ttfbMs,
        totalMs: performance.now() - started
      })
    })

    request.on('socket', (socket) => {
      const onConnect = () => {
        tcpMs = performance.now() - started
      }
      if (socket.connecting) socket.once('connect', onConnect)
      else onConnect()
      if (url.protocol === 'https:') {
        socket.once('secureConnect', () => {
          tlsMs = performance.now() - started
        })
      }
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })
    request.on('error', fail)
    deadline = setTimeout(() => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`))
    }, timeoutMs + 250)
    request.end()
  })
}

async function probeOnce(source, options) {
  const url = new URL(source.probeUrl || defaultProbeUrl(source))
  if (url.protocol !== 'https:' && !(options.allowInsecure && url.protocol === 'http:')) {
    throw new Error(`unsupported probe protocol: ${url.protocol}`)
  }
  const addresses = await resolveAddresses(url.hostname, options)
  const address = addresses[0]
  return requestOnce(url, { ...options, address })
}

/**
 * Probe one source. The first sample is a warm-up and is excluded from the
 * median; all samples still contribute to the success rate.
 */
export async function probeSource(source, options = {}) {
  const samples = Math.max(1, Math.min(8, Number(options.samples) || 3))
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || 3000)
  const allowPrivateHosts = options.allowPrivateHosts === true
  const allowInsecure = options.allowInsecure === true
  const attempts = []
  for (let index = 0; index < samples; index += 1) {
    try {
      const measurement = await probeOnce(source, { timeoutMs, allowPrivateHosts, allowInsecure })
      attempts.push({ ...measurement, ok: measurement.ok !== false })
    } catch (error) {
      attempts.push({ ok: false, error: errorMessage(error), ttfbMs: undefined })
    }
  }
  const measured = attempts.length > 1 ? attempts.slice(1) : attempts
  const successful = measured.filter((attempt) => attempt.ok)
  const firstFailure = attempts.find((attempt) => !attempt.ok)?.error
  const measurement = {
    sourceId: source.id,
    label: source.label,
    ecosystem: source.ecosystem,
    status: successful.length > 0 ? 'ok' : 'fail',
    samples,
    successCount: successful.length,
    successRate: successful.length / Math.max(1, measured.length),
    httpStatus: successful.at(-1)?.statusCode,
    tcpMs: median(measured.map((attempt) => attempt.tcpMs).filter((value) => typeof value === 'number')),
    tlsMs: median(measured.map((attempt) => attempt.tlsMs).filter((value) => typeof value === 'number')),
    ttfbMs: median(successful.map((attempt) => attempt.ttfbMs).filter((value) => typeof value === 'number')),
    measuredAt: Date.now(),
    ...(successful.length === 0 && firstFailure ? { error: firstFailure } : {})
  }
  return measurement
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export async function probeMany(sources, options = {}) {
  return mapWithConcurrency(sources, Number(options.concurrency) || 4, (source) => probeSource(source, options))
}

export function scoreMeasurement(measurement) {
  if (measurement.status !== 'ok' || typeof measurement.ttfbMs !== 'number') return Number.POSITIVE_INFINITY
  return measurement.ttfbMs + (1 - measurement.successRate) * 1000
}

export function selectFastest(measurements) {
  return [...measurements]
    .filter((measurement) => measurement.status === 'ok')
    .sort((left, right) => {
      const score = scoreMeasurement(left) - scoreMeasurement(right)
      if (Math.abs(score) > 0.001) return score
      return String(left.sourceId).localeCompare(String(right.sourceId))
    })[0]
}
