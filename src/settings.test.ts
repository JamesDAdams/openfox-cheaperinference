import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginSettingsStore, DEFAULT_SETTINGS } from './settings.js'

describe('CheaperInference PluginSettingsStore', () => {
  let tempDir: string
  let settingsPath: string
  let store: PluginSettingsStore

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cheaperinference-settings-test-'))
    settingsPath = join(tempDir, 'settings.json')
    store = new PluginSettingsStore(settingsPath)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('loads default settings when file does not exist', async () => {
    const settings = await store.load()
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(settings.showDiscount).toBe(true)
  })

  it('saves and reloads custom settings including showDiscount toggle', async () => {
    const updated = await store.save({
      showDiscount: false,
      modelsRefreshIntervalMinutes: 45,
    })

    expect(updated.showDiscount).toBe(false)
    expect(updated.modelsRefreshIntervalMinutes).toBe(45)

    const reloaded = await store.load()
    expect(reloaded.showDiscount).toBe(false)
    expect(reloaded.modelsRefreshIntervalMinutes).toBe(45)
  })
})
