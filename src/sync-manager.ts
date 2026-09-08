import type { ModelConfig } from 'openfox/provider'
import type { CheaperInferenceTransportAdapter } from './transport/cheaperinference.js'
import type { CheaperInferencePluginSettings, ModelPricing } from './types.js'

type ModelWithPricing = ModelConfig & { pricing?: ModelPricing }

export interface PriceDiff {
  modelId: string
  oldPricing?: ModelPricing
  newPricing?: ModelPricing
}

function formatDiscountValue(val: number | string | undefined): string {
  if (val === undefined || val === null || val === '') return 'none'
  const str = String(val).trim()
  return str.endsWith('%') ? str : `${str}%`
}

export function formatPriceDiffBody(priceDiffs: PriceDiff[], maxModels = 2): string {
  if (priceDiffs.length === 0) return ''

  const formattedModels = priceDiffs.slice(0, maxModels).map((diff) => {
    const changes: string[] = []
    const oldP = diff.oldPricing ?? {}
    const newP = diff.newPricing ?? {}

    if (oldP.input !== newP.input) {
      const oldVal = oldP.input !== undefined ? `$${oldP.input}` : 'none'
      const newVal = newP.input !== undefined ? `$${newP.input}` : 'none'
      changes.push(`in ${oldVal}->${newVal}`)
    }

    if (oldP.output !== newP.output) {
      const oldVal = oldP.output !== undefined ? `$${oldP.output}` : 'none'
      const newVal = newP.output !== undefined ? `$${newP.output}` : 'none'
      changes.push(`out ${oldVal}->${newVal}`)
    }

    if (oldP.cacheRead !== newP.cacheRead) {
      const oldVal = oldP.cacheRead !== undefined ? `$${oldP.cacheRead}` : 'none'
      const newVal = newP.cacheRead !== undefined ? `$${newP.cacheRead}` : 'none'
      changes.push(`cacheRead ${oldVal}->${newVal}`)
    }

    if (oldP.cacheWrite !== newP.cacheWrite) {
      const oldVal = oldP.cacheWrite !== undefined ? `$${oldP.cacheWrite}` : 'none'
      const newVal = newP.cacheWrite !== undefined ? `$${newP.cacheWrite}` : 'none'
      changes.push(`cacheWrite ${oldVal}->${newVal}`)
    }

    if (oldP.discount !== newP.discount) {
      const oldVal = formatDiscountValue(oldP.discount)
      const newVal = formatDiscountValue(newP.discount)
      changes.push(`promo ${oldVal}->${newVal}`)
    }

    const detail = changes.length > 0 ? changes.join(', ') : 'pricing updated'
    return `${diff.modelId}: ${detail}`
  })

  const remaining = priceDiffs.length - maxModels
  if (remaining > 0) {
    return `${formattedModels.join('; ')} (+${remaining} others)`
  }

  return formattedModels.join('; ')
}

export interface SyncManagerOptions {
  transport: CheaperInferenceTransportAdapter
  settings: CheaperInferencePluginSettings
  notify?: (notification: { title: string; body: string }) => void
}

export class CheaperInferenceSyncManager {
  private timer: NodeJS.Timeout | null = null
  private knownModelIds = new Set<string>()
  private knownModelPricing = new Map<string, ModelPricing>()
  private lastDiscoveredModels: string[] = []
  private lastRemovedModels: string[] = []
  private lastPriceDiffs: PriceDiff[] = []
  private isInitialized = false

  constructor(private readonly options: SyncManagerOptions) {}

  updateSettings(settings: CheaperInferencePluginSettings): void {
    this.options.settings = settings
    this.restart()
  }

  start(): void {
    this.stop()
    const intervalMs = (this.options.settings.modelsRefreshIntervalMinutes || 60) * 60 * 1000

    if (this.options.settings.checkModelsOnStartup || this.options.settings.checkPricesOnStartup) {
      void this.syncAll()
    }

    this.timer = setInterval(() => {
      void this.syncAll()
    }, intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  restart(): void {
    this.start()
  }

  async syncAll(): Promise<{ models: ModelConfig[]; priceDiffs: PriceDiff[] }> {
    const dummyContext = {
      provider: {
        id: 'cheaperinference',
        name: 'CheaperInference',
        url: 'https://api.cheaperinference.com/v1',
        backend: 'openai' as const,
      },
    }

    const models = (await this.options.transport.listModels(dummyContext as any)) as ModelWithPricing[]
    const currentIds = new Set(models.map((m) => m.id))
    const priceDiffs: PriceDiff[] = []

    if (this.isInitialized) {
      const newModels: string[] = []
      const removedModels: string[] = []

      for (const id of currentIds) {
        if (!this.knownModelIds.has(id)) {
          newModels.push(id)
        }
      }

      for (const id of this.knownModelIds) {
        if (!currentIds.has(id)) {
          removedModels.push(id)
        }
      }

      for (const m of models) {
        if (m.pricing) {
          const prev = this.knownModelPricing.get(m.id)
          if (prev && JSON.stringify(prev) !== JSON.stringify(m.pricing)) {
            priceDiffs.push({ modelId: m.id, oldPricing: prev, newPricing: m.pricing })
          }
        }
      }

      this.lastDiscoveredModels = newModels
      this.lastRemovedModels = removedModels
      this.lastPriceDiffs = priceDiffs

      if (this.options.notify) {
        if (newModels.length > 0 || removedModels.length > 0) {
          const parts: string[] = []
          if (newModels.length > 0) parts.push(`New: ${newModels.slice(0, 3).join(', ')}${newModels.length > 3 ? '...' : ''}`)
          if (removedModels.length > 0) parts.push(`Removed: ${removedModels.slice(0, 3).join(', ')}${removedModels.length > 3 ? '...' : ''}`)
          this.options.notify({
            title: 'CheaperInference Models Updated',
            body: parts.join(' | '),
          })
        } else if (priceDiffs.length > 0 && this.options.settings.notifyOnPriceChanges) {
          this.options.notify({
            title: 'CheaperInference Pricing Updated',
            body: formatPriceDiffBody(priceDiffs),
          })
        } else if (this.options.settings.notifyOnEveryCheck) {
          this.options.notify({
            title: 'CheaperInference Check Completed',
            body: `${models.length} models verified`,
          })
        }
      }
    } else {
      this.isInitialized = true
    }

    this.knownModelIds = currentIds
    this.knownModelPricing.clear()
    for (const m of models) {
      if (m.pricing) {
        this.knownModelPricing.set(m.id, m.pricing)
      }
    }

    return { models, priceDiffs }
  }

  getLastDiscoveredModels(): string[] {
    return this.lastDiscoveredModels
  }

  getLastRemovedModels(): string[] {
    return this.lastRemovedModels
  }

  getLastPriceDiffs(): PriceDiff[] {
    return this.lastPriceDiffs
  }
}
