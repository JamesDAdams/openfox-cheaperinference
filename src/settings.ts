import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CheaperInferencePluginSettings } from './types.js'

export type { CheaperInferencePluginSettings } from './types.js'

export const DEFAULT_SETTINGS: CheaperInferencePluginSettings = {
  checkModelsOnStartup: true,
  modelsRefreshIntervalMinutes: 60,
  checkPricesOnStartup: true,
  pricesRefreshIntervalMinutes: 60,
  notifyOnNewModelsOnly: true,
  notifyOnPriceChanges: true,
  notifyOnEveryCheck: false,
  showDiscount: true,
}

export class PluginSettingsStore {
  private cached: CheaperInferencePluginSettings | null = null

  constructor(private readonly settingsPath: string) {}

  async load(): Promise<CheaperInferencePluginSettings> {
    if (this.cached) return this.cached
    try {
      const raw = await readFile(this.settingsPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<CheaperInferencePluginSettings>
      this.cached = {
        ...DEFAULT_SETTINGS,
        ...parsed,
      }
      return this.cached
    } catch {
      this.cached = { ...DEFAULT_SETTINGS }
      return this.cached
    }
  }

  async save(
    values: Partial<CheaperInferencePluginSettings>,
  ): Promise<CheaperInferencePluginSettings> {
    const current = await this.load()
    const merged: CheaperInferencePluginSettings = {
      ...current,
      ...values,
    }
    await mkdir(dirname(this.settingsPath), { recursive: true })
    await writeFile(this.settingsPath, JSON.stringify(merged, null, 2), 'utf8')
    this.cached = merged
    return merged
  }

  getCached(): CheaperInferencePluginSettings {
    return this.cached ?? DEFAULT_SETTINGS
  }
}
