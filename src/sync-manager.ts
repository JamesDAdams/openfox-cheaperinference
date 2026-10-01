import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ModelConfig } from 'openfox/provider'
import type { CheaperInferenceTransportAdapter } from './transport/cheaperinference.js'
import type { CheaperInferencePluginSettings, ModelPricing } from './types.js'

type ModelWithPricing = ModelConfig & { pricing?: ModelPricing }

export interface PriceDiff {
  modelId: string
  oldPricing?: ModelPricing
  newPricing?: ModelPricing
}

function getCandidateConfigDirs(explicitDir?: string): string[] {
  if (explicitDir) {
    return [explicitDir]
  }
  const dirs: string[] = []
  if (process.env.OPENFOX_CONFIG_DIR) dirs.push(process.env.OPENFOX_CONFIG_DIR)
  try {
    const home = homedir()
    if (home) {
      dirs.push(join(home, 'Library', 'Application Support', 'openfox-dev'))
      dirs.push(join(home, 'Library', 'Application Support', 'openfox'))
      dirs.push(join(home, '.config', 'openfox-dev'))
      dirs.push(join(home, '.config', 'openfox'))
    }
  } catch {}
  return Array.from(new Set(dirs))
}

export async function syncCheaperInferenceConfigProviders(
  models: ModelConfig[],
  removedModelIds: string[],
  settings: CheaperInferencePluginSettings,
  configDirectory?: string,
): Promise<{ added: number; removed: number }> {
  const autoAdd = settings.autoAddModels !== false
  const autoRemove = Boolean(settings.autoRemoveModels)
  if (!autoAdd && !autoRemove) return { added: 0, removed: 0 }

  const candidateDirs = getCandidateConfigDirs(configDirectory)
  let totalAdded = 0
  let totalRemoved = 0

  for (const dir of candidateDirs) {
    try {
      const configPath = join(dir, 'config.json')
      const raw = await readFile(configPath, 'utf8')
      const config = JSON.parse(raw)
      if (!Array.isArray(config?.providers)) continue

      let changed = false
      for (const p of config.providers) {
        if (!p || typeof p !== 'object') continue
        const backend = String(p.backend || '').toLowerCase()
        const transport = String(p.transport || p.transportAdapter || '').toLowerCase()
        const preset = String(p.preset || '').toLowerCase()
        const authAdapter = String(p.authAdapter || '').toLowerCase()
        const url = String(p.url || '').toLowerCase()
        const name = String(p.name || '').toLowerCase()
        const id = String(p.id || '').toLowerCase()

        const isMatch =
          preset === 'cheaperinference' ||
          backend === 'cheaperinference' ||
          transport === 'cheaperinference-transport' ||
          authAdapter === 'cheaperinference-auth' ||
          url.includes('cheaperinference') ||
          name.includes('cheaper') ||
          id.includes('cheaper')

        if (!isMatch) continue

        p.models = Array.isArray(p.models) ? p.models : []
        const existingIds = new Set(p.models.map((m: any) => (typeof m === 'string' ? m : m.id)))

        if (autoAdd && models.length > 0) {
          for (const m of models) {
            if (!existingIds.has(m.id)) {
              p.models.push({
                id: m.id,
                name: m.name ?? m.id,
                contextWindow: m.contextWindow ?? 128000,
                source: 'backend',
                ...(m.supportsVision ? { supportsVision: m.supportsVision } : {}),
                ...(m.requestBody ? { requestBody: m.requestBody } : {}),
                ...((m as any).pricing ? { pricing: (m as any).pricing } : {}),
              })
              existingIds.add(m.id)
              totalAdded++
              changed = true
            }
          }
        }

        if (autoRemove && removedModelIds.length > 0) {
          const toRemove = new Set(removedModelIds)
          const prevCount = p.models.length
          p.models = p.models.filter((m: any) => !toRemove.has(typeof m === 'string' ? m : m.id))
          if (p.models.length !== prevCount) {
            totalRemoved += prevCount - p.models.length
            changed = true
          }
        }
      }

      if (changed) {
        await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8')
      }
    } catch {
      // Ignore config read/parse/write errors
    }
  }

  return { added: totalAdded, removed: totalRemoved }
}

function roundUpTo3Decimals(val: number | undefined): number | undefined {
  if (val === undefined || isNaN(val)) return undefined
  if (val === 0) return 0
  const scaled = Math.round(val * 1e8) / 1e5
  return Math.ceil(scaled) / 1000
}

function formatPriceValue(val: number | undefined): string {
  if (val === undefined || val === null || isNaN(val)) return 'none'
  if (val === 0) return '$0'

  const rounded = roundUpTo3Decimals(val) ?? 0
  return `$${rounded.toFixed(3)}`
}

function formatDiscountValue(val: number | string | undefined): string {
  if (val === undefined || val === null || val === '') return 'none'
  if (typeof val === 'number') {
    return `${Math.round(val)}%`
  }
  const str = String(val).trim()
  if (str.endsWith('%')) {
    const num = parseFloat(str.slice(0, -1))
    return isNaN(num) ? str : `${Math.round(num)}%`
  }
  const num = parseFloat(str)
  return isNaN(num) ? `${str}%` : `${Math.round(num)}%`
}

export function formatPriceDiffBody(priceDiffs: PriceDiff[], maxModels = 2): string {
  if (priceDiffs.length === 0) return ''

  const formattedModels = priceDiffs.slice(0, maxModels).map((diff) => {
    const changes: string[] = []
    const oldP = diff.oldPricing ?? {}
    const newP = diff.newPricing ?? {}

    if (oldP.input !== newP.input) {
      changes.push(`• In: ${formatPriceValue(oldP.input)} → ${formatPriceValue(newP.input)}`)
    }

    if (oldP.output !== newP.output) {
      changes.push(`• Out: ${formatPriceValue(oldP.output)} → ${formatPriceValue(newP.output)}`)
    }

    if (oldP.cacheRead !== newP.cacheRead) {
      changes.push(`• Cache Read: ${formatPriceValue(oldP.cacheRead)} → ${formatPriceValue(newP.cacheRead)}`)
    }

    if (oldP.cacheWrite !== newP.cacheWrite) {
      changes.push(`• Cache Write: ${formatPriceValue(oldP.cacheWrite)} → ${formatPriceValue(newP.cacheWrite)}`)
    }

    if (oldP.discount !== newP.discount) {
      changes.push(`• Promo: ${formatDiscountValue(oldP.discount)} → ${formatDiscountValue(newP.discount)}`)
    }

    const detail = changes.length > 0 ? changes.join('\n') : '• Pricing updated'
    return `${diff.modelId}:\n${detail}`
  })

  const remaining = priceDiffs.length - maxModels
  if (remaining > 0) {
    return `${formattedModels.join('\n\n')}\n\n(+${remaining} other${remaining > 1 ? 's' : ''})`
  }

  return formattedModels.join('\n\n')
}

export interface SyncNotification {
  title: string | { en: string; fr: string }
  body?: string | { en: string; fr: string }
  level?: 'info' | 'success' | 'warning' | 'error'
}

export interface SyncManagerOptions {
  transport: CheaperInferenceTransportAdapter
  settings: CheaperInferencePluginSettings
  notify?: (notification: SyncNotification) => void
  configDirectory?: string
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
    const newModels: string[] = []
    const removedModels: string[] = []

    if (this.isInitialized) {
      for (const id of currentIds) {
        if (!this.knownModelIds.has(id)) newModels.push(id)
      }
      for (const id of this.knownModelIds) {
        if (!currentIds.has(id)) removedModels.push(id)
      }
      for (const model of models) {
        if (!model.pricing) continue
        const previous = this.knownModelPricing.get(model.id)
        if (previous && JSON.stringify(previous) !== JSON.stringify(model.pricing)) {
          priceDiffs.push({ modelId: model.id, oldPricing: previous, newPricing: model.pricing })
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
          title: { en: 'CheaperInference Models Updated', fr: 'Modèles CheaperInference mis à jour' },
          body: { en: parts.join(' | '), fr: parts.join(' | ') },
          level: 'info',
        })
      } else if (priceDiffs.length > 0 && this.options.settings.notifyOnPriceChanges) {
        const body = formatPriceDiffBody(priceDiffs)
        this.options.notify({
          title: { en: 'CheaperInference Pricing Updated', fr: 'Prix CheaperInference mis à jour' },
          body: { en: body, fr: body },
          level: 'info',
        })
      } else if (this.options.settings.notifyOnEveryCheck) {
        this.options.notify({
          title: { en: 'CheaperInference Check Completed', fr: 'Vérification CheaperInference terminée' },
          body: {
            en: `${models.length} models verified. No pricing changes.`,
            fr: `${models.length} modèles vérifiés. Aucun changement de prix.`,
          },
          level: 'info',
        })
      }
    }

    this.isInitialized = true
    this.knownModelIds = currentIds
    this.knownModelPricing.clear()
    for (const model of models) {
      if (model.pricing) this.knownModelPricing.set(model.id, model.pricing)
    }

    if (this.options.settings.autoAddModels !== false || (this.options.settings.autoRemoveModels && removedModels.length > 0)) {
      await syncCheaperInferenceConfigProviders(
        models,
        removedModels,
        this.options.settings,
        this.options.configDirectory,
      ).catch(() => {})
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
