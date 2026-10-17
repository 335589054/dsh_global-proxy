import path from 'node:path'
import { readTextIfExists, stateDirectory, writeTextAtomic } from './util.js'

const EMPTY_STATE = Object.freeze({
  version: 1,
  settings: {},
  customSources: [],
  applied: {},
  lastProbe: {}
})

function cloneEmpty() {
  return JSON.parse(JSON.stringify(EMPTY_STATE))
}

function normalizeLoaded(value) {
  const state = cloneEmpty()
  if (!value || typeof value !== 'object') return state
  if (value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings)) {
    state.settings = value.settings
  }
  if (Array.isArray(value.customSources)) state.customSources = value.customSources
  if (value.applied && typeof value.applied === 'object' && !Array.isArray(value.applied)) {
    state.applied = value.applied
  }
  if (value.lastProbe && typeof value.lastProbe === 'object' && !Array.isArray(value.lastProbe)) {
    state.lastProbe = value.lastProbe
  }
  return state
}

export class StateStore {
  constructor({ file = path.join(stateDirectory(), 'state.json'), backupRoot = path.join(stateDirectory(), 'backups') } = {}) {
    this.file = file
    this.backupRoot = backupRoot
    this.state = cloneEmpty()
    this.loaded = false
  }

  async load() {
    try {
      const { exists, text } = await readTextIfExists(this.file)
      if (!exists) {
        this.loaded = true
        return this.state
      }
      this.state = normalizeLoaded(JSON.parse(text))
    } catch {
      const { text } = await readTextIfExists(this.file).catch(() => ({ text: '' }))
      if (text) {
        await writeTextAtomic(`${this.file}.corrupt-${Date.now()}`, text)
      }
      this.state = cloneEmpty()
    }
    this.loaded = true
    return this.state
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state))
  }

  get settings() {
    return this.state.settings
  }

  get customSources() {
    return this.state.customSources
  }

  get applied() {
    return this.state.applied
  }

  async save() {
    await writeTextAtomic(this.file, `${JSON.stringify(this.state, null, 2)}\n`)
  }

  async updateSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch }
    await this.save()
  }

  async setSettings(patch) {
    this.state.settings = patch
    await this.save()
  }

  async addSource(source) {
    this.state.customSources = [...this.state.customSources, source]
    await this.save()
  }

  async removeSource(id) {
    const next = this.state.customSources.filter((source) => source.id !== id)
    if (next.length === this.state.customSources.length) return false
    this.state.customSources = next
    await this.save()
    return true
  }

  async setApplied(target, record) {
    this.state.applied = { ...this.state.applied, [target]: record }
    await this.save()
  }

  async clearApplied(target) {
    if (!(target in this.state.applied)) return
    const next = { ...this.state.applied }
    delete next[target]
    this.state.applied = next
    await this.save()
  }

  async setLastProbe(target, measurements) {
    this.state.lastProbe = { ...this.state.lastProbe, [target]: measurements }
    await this.save()
  }
}
