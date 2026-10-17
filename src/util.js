import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

export const execFileAsync = promisify(execFile)

/** Resolve the harness home without relying on the shell environment. */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function stateDirectory() {
  return path.join(resolveDshHome(), 'always-in-proxy')
}

export function homePath(...parts) {
  return path.join(os.homedir(), ...parts)
}

export function userNpmrcPath() {
  return homePath('.npmrc')
}

export function userPipConfigPath() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'pip', 'pip.ini')
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(xdg, 'pip', 'pip.conf')
}

export async function readTextIfExists(file) {
  try {
    return { exists: true, text: await readFile(file, 'utf8') }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, text: '' }
    throw error
  }
}

export async function ensureDirectory(dir) {
  await mkdir(dir, { recursive: true })
}

/**
 * Write a text file atomically. On Windows a rename over an existing file can
 * fail while a reader holds it; fall back to copy+remove for that case.
 */
export async function writeTextAtomic(file, text, mode = 0o600) {
  await ensureDirectory(path.dirname(file))
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, text, { encoding: 'utf8', mode })
  try {
    await rename(temporary, file)
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES')) {
      try {
        await copyFile(temporary, file)
        await rm(temporary, { force: true })
        return
      } catch (fallbackError) {
        await rm(temporary, { force: true }).catch(() => {})
        throw fallbackError
      }
    }
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function copyToBackup(file, backupDirectory, name = path.basename(file)) {
  await ensureDirectory(backupDirectory)
  const target = path.join(backupDirectory, name)
  await copyFile(file, target)
  return target
}

export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export async function fileStat(file) {
  try {
    return await stat(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}

export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n')
}

export function median(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function formatMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}ms` : '-'
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Small recursive merge used for defaults, patch config and persisted settings. */
export function mergePlain(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergePlain(base[key], value) : value
  }
  return result
}

export function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

export function uniq(values) {
  return [...new Set(values)]
}
