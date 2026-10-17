import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { applyGit, applyNpm, applyPip, resetGit, restoreFileRecord } from '../src/appliers.js'
import { BUILTIN_SOURCES, SourceCatalog, mergeConfig, normalizeSource } from '../src/catalog.js'
import { MirrorManager } from '../src/manager.js'
import { isPrivateAddress, probeSource } from '../src/probe.js'
import { StateStore } from '../src/state.js'

const execFileAsync = promisify(execFile)
const temporary = await mkdtemp(path.join(os.tmpdir(), 'always-in-proxy-'))
const backupDir = path.join(temporary, 'backups')

try {
  // npm: managed block, token preservation, exact restore.
  const npmFile = path.join(temporary, '.npmrc')
  const npmOriginal = '//registry.npmjs.org/:_authToken=secret-token\nregistry=https://registry.npmjs.org\n'
  await writeFile(npmFile, npmOriginal)
  const npmRecord = await applyNpm(BUILTIN_SOURCES[1], { backupDir, file: npmFile })
  const npmApplied = await readFile(npmFile, 'utf8')
  assert.equal(npmRecord.changed, true)
  assert.match(npmApplied, /# >>> always-in-proxy >>>/)
  assert.match(npmApplied, /registry=https:\/\/registry\.npmmirror\.com/)
  assert.match(npmApplied, /secret-token/)
  await restoreFileRecord(npmRecord)
  assert.equal(await readFile(npmFile, 'utf8'), npmOriginal)

  // pip: only index-url is edited; extra-index-url and another section survive.
  const pipFile = path.join(temporary, 'pip.ini')
  const pipOriginal = '[global]\nindex-url = https://pypi.org/simple\nextra-index-url = https://example.com/simple\n\n[install]\nno-warn-script-location = true\n'
  await writeFile(pipFile, pipOriginal)
  const pipRecord = await applyPip(BUILTIN_SOURCES[2], { backupDir, file: pipFile })
  const pipApplied = await readFile(pipFile, 'utf8')
  assert.match(pipApplied, /\[global\]\nindex-url = https:\/\/pypi\.tuna\.tsinghua\.edu\.cn\/simple/)
  assert.match(pipApplied, /extra-index-url = https:\/\/example\.com\/simple/)
  assert.match(pipApplied, /no-warn-script-location = true/)
  await restoreFileRecord(pipRecord)
  assert.equal(await readFile(pipFile, 'utf8'), pipOriginal)

  // git: apply and remove only the pair this plugin added.
  const gitConfig = path.join(temporary, '.gitconfig')
  await writeFile(gitConfig, '[user]\n\tname = Test User\n')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig }
  const gitSource = BUILTIN_SOURCES[0]
  const gitRecord = await applyGit(gitSource, { env })
  const key = gitRecord.key
  const { stdout: afterApply } = await execFileAsync('git', ['config', '--global', '--get-all', key], { env })
  assert.match(afterApply, /https:\/\/github\.com\//)
  await resetGit(gitRecord, { env })
  let values = ''
  try {
    values = (await execFileAsync('git', ['config', '--global', '--get-all', key], { env })).stdout
  } catch {
    values = ''
  }
  assert.equal(values.trim(), '')
  assert.match(await readFile(gitConfig, 'utf8'), /Test User/)

  // idempotency: second apply is a no-op.
  const noopRecord = await applyNpm(BUILTIN_SOURCES[1], { backupDir, file: npmFile })
  const noopAgain = await applyNpm(BUILTIN_SOURCES[1], { backupDir, file: npmFile })
  assert.equal(noopRecord.changed, true)
  assert.equal(noopAgain.changed, false)
  await restoreFileRecord(noopRecord, { force: true })

  // Source normalization and catalog.
  const custom = normalizeSource({
    id: 'npm-company',
    label: 'Company',
    ecosystem: 'npm',
    baseUrl: 'https://npm.example.com/',
    priority: 1
  }, mergeConfig())
  assert.equal(custom.baseUrl, 'https://npm.example.com')
  const catalog = new SourceCatalog({ customSources: [custom], config: mergeConfig() })
  assert.equal(catalog.forEcosystem('npm').length, 2)

  // Manager URL rewrite uses the applied/default GitHub source.
  const state = new StateStore({
    file: path.join(temporary, 'state.json'),
    backupRoot: path.join(temporary, 'state-backups')
  })
  const manager = new MirrorManager({ rawConfig: {}, stateStore: state, env })
  await manager.ready
  const rewritten = manager.rewriteGithubUrl('https://github.com/octocat/Hello-World')
  assert.equal(rewritten.url, 'https://gh-proxy.org/https://github.com/octocat/Hello-World')
  assert.throws(() => manager.rewriteGithubUrl('https://example.com/file'), /not a supported GitHub host/)

  // SSRF classifier.
  assert.equal(isPrivateAddress('127.0.0.1'), true)
  assert.equal(isPrivateAddress('10.1.2.3'), true)
  assert.equal(isPrivateAddress('192.168.1.1'), true)
  assert.equal(isPrivateAddress('8.8.8.8'), false)

  // One live probe is reported but does not fail the suite when offline.
  const probe = await probeSource(BUILTIN_SOURCES[0], { samples: 1, timeoutMs: 5000 })
  console.log(`probe ${probe.sourceId}: ${probe.status}${probe.ttfbMs ? ` ${Math.round(probe.ttfbMs)}ms` : ''}${probe.error ? ` (${probe.error})` : ''}`)

  console.log('smoke ok')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
