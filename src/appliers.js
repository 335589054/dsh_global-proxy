import path from 'node:path'
import { rm } from 'node:fs/promises'
import { copyToBackup, errorMessage, execFileAsync, fileStat, hashText, normalizeEol, readTextIfExists, userNpmrcPath, userPipConfigPath, writeTextAtomic } from './util.js'

const NPM_BEGIN = '# >>> always-in-proxy >>>'
const NPM_END = '# <<< always-in-proxy <<<'
const GITHUB_ORIGINAL = 'https://github.com/'

function recordFor({ target, file, existed, backupPath, beforeText = '', afterText = '', extra = {} }) {
  return {
    target,
    file,
    existed,
    backupPath,
    beforeHash: hashText(beforeText),
    afterHash: hashText(afterText),
    appliedAt: Date.now(),
    ...extra
  }
}

async function backupCurrent(file, backupDir) {
  const info = await fileStat(file)
  if (!info) return { existed: false, backupPath: undefined }
  const backupPath = await copyToBackup(file, backupDir)
  return { existed: true, backupPath }
}

function stripNpmBlock(text) {
  const lines = normalizeEol(text).split('\n')
  const start = lines.findIndex((line) => line.trim() === NPM_BEGIN)
  if (start < 0) return lines.join('\n')
  const end = lines.findIndex((line, index) => index > start && line.trim() === NPM_END)
  if (end < 0) return lines.join('\n')
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n')
}

export async function applyNpm(source, { backupDir, file = userNpmrcPath() } = {}) {
  const current = await readTextIfExists(file)
  const withoutBlock = stripNpmBlock(current.text)
  const base = withoutBlock.replace(/\s+$/, '')
  const block = `${NPM_BEGIN}\nregistry=${source.baseUrl}\n${NPM_END}`
  const next = `${base.length > 0 ? `${base}\n\n` : ''}${block}\n`
  const changed = next !== current.text
  if (!changed) {
    return recordFor({ target: 'npm', file, existed: current.exists, beforeText: current.text, afterText: current.text, extra: { sourceId: source.id, changed: false } })
  }
  const backup = await backupCurrent(file, backupDir)
  await writeTextAtomic(file, next)
  return recordFor({
    target: 'npm',
    file,
    existed: backup.existed,
    backupPath: backup.backupPath,
    beforeText: current.text,
    afterText: next,
    extra: { sourceId: source.id, changed: true }
  })
}

function findGlobalSection(lines) {
  const start = lines.findIndex((line) => /^\s*\[global\]\s*$/i.test(line))
  if (start < 0) return { start: -1, end: -1 }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      end = index
      break
    }
  }
  return { start, end }
}

export async function applyPip(source, { backupDir, file = userPipConfigPath() } = {}) {
  const current = await readTextIfExists(file)
  const eol = current.text.includes('\r\n') ? '\r\n' : '\n'
  const normalized = normalizeEol(current.text)
  const lines = normalized.split('\n')
  const section = findGlobalSection(lines)
  const keyPattern = /^\s*index-url\s*=/i
  const nextLine = `index-url = ${source.baseUrl}`

  if (section.start < 0) {
    while (lines.length > 0 && lines.at(-1) === '') lines.pop()
    if (lines.length > 0 && lines.at(-1).trim() !== '') lines.push('')
    lines.push('[global]', nextLine)
  } else {
    let keyIndex = -1
    for (let index = section.start + 1; index < section.end; index += 1) {
      if (keyPattern.test(lines[index])) {
        keyIndex = index
        break
      }
    }
    if (keyIndex >= 0) {
      lines[keyIndex] = nextLine
    } else {
      lines.splice(section.start + 1, 0, nextLine)
    }
  }

  const next = lines.join(eol) + (lines.at(-1) === '' ? '' : eol)
  const changed = next !== current.text
  if (!changed) {
    return recordFor({ target: 'pip', file, existed: current.exists, beforeText: current.text, afterText: current.text, extra: { sourceId: source.id, changed: false } })
  }
  const backup = await backupCurrent(file, backupDir)
  await writeTextAtomic(file, next)
  return recordFor({
    target: 'pip',
    file,
    existed: backup.existed,
    backupPath: backup.backupPath,
    beforeText: current.text,
    afterText: next,
    extra: { sourceId: source.id, changed: true }
  })
}

export async function restoreFileRecord(record, { force = false } = {}) {
  if (!record || !record.file) throw new Error('invalid applied record')
  const current = await readTextIfExists(record.file)
  if (current.exists && record.afterHash && hashText(current.text) !== record.afterHash && !force) {
    throw new Error(`conflict: ${record.file} was modified after apply; refusing to overwrite (use --force to restore the backup)`)
  }
  if (record.existed) {
    if (!record.backupPath) throw new Error(`missing backup for ${record.file}`)
    const backup = await readTextIfExists(record.backupPath)
    if (!backup.exists) throw new Error(`missing backup file: ${record.backupPath}`)
    await writeTextAtomic(record.file, backup.text)
    return { target: record.target, file: record.file, restored: true, removed: false }
  }
  if (current.exists) {
    await rm(record.file, { force: true })
  }
  return { target: record.target, file: record.file, restored: true, removed: true }
}

export function gitConfigPath(env = process.env) {
  if (env.GIT_CONFIG_GLOBAL) return env.GIT_CONFIG_GLOBAL
  return path.join(env.USERPROFILE || env.HOME || process.cwd(), '.gitconfig')
}

function gitEnv(env = process.env) {
  return { ...process.env, ...env }
}

async function runGit(args, env) {
  try {
    const result = await execFileAsync('git', args, {
      env: gitEnv(env),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20000
    })
    return result.stdout
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error('git is not installed or not on PATH')
    const detail = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n').trim()
    const wrapped = new Error(detail || 'git command failed')
    wrapped.code = error?.code
    throw wrapped
  }
}

async function getAllGitValues(key, env) {
  try {
    const stdout = await runGit(['config', '--global', '--get-all', key], env)
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  } catch (error) {
    if (error?.code === 1 || /\bnot found\b|exit code 1|key does not contain/i.test(errorMessage(error))) return []
    throw error
  }
}

export async function applyGit(source, { env = process.env } = {}) {
  const prefix = source.baseUrl.endsWith('/') ? source.baseUrl : `${source.baseUrl}/`
  const key = `url.${prefix}${GITHUB_ORIGINAL}.insteadOf`
  const existing = await getAllGitValues(key, env)
  if (existing.includes(GITHUB_ORIGINAL)) {
    return {
      target: 'github',
      sourceId: source.id,
      file: gitConfigPath(env),
      key,
      value: GITHUB_ORIGINAL,
      added: false,
      changed: false
    }
  }
  await runGit(['config', '--global', '--add', key, GITHUB_ORIGINAL], env)
  return {
    target: 'github',
    sourceId: source.id,
    file: gitConfigPath(env),
    key,
    value: GITHUB_ORIGINAL,
    added: true,
    changed: true
  }
}

export async function resetGit(record, { env = process.env, force = false } = {}) {
  if (!record?.key || record.added !== true) {
    return { target: 'github', file: record?.file ?? gitConfigPath(env), restored: false, removed: false }
  }
  const values = await getAllGitValues(record.key, env)
  if (!values.includes(GITHUB_ORIGINAL)) {
    return { target: 'github', file: gitConfigPath(env), restored: true, removed: false }
  }
  const remaining = values.filter((value) => value !== GITHUB_ORIGINAL)
  if (remaining.length === 0) {
    await runGit(['config', '--global', '--unset-all', record.key], env)
  } else {
    await runGit(['config', '--global', '--replace-all', record.key, remaining[0]], env)
    for (const value of remaining.slice(1)) {
      await runGit(['config', '--global', '--add', record.key, value], env)
    }
  }
  return { target: 'github', file: gitConfigPath(env), restored: true, removed: true, forced: force }
}
