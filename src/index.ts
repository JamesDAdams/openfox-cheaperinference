import { join } from 'node:path'
import type { ProviderPluginRegistry, ProviderPreset } from 'openfox/provider'
import { FileProviderCredentialStore } from './credentials/file-credential-store.js'
import { CheaperInferenceAuthAdapter } from './auth/cheaperinference-auth.js'
import { CheaperInferenceTransportAdapter } from './transport/cheaperinference.js'
import {
  CheaperInferenceQuotaProvider,
  CheaperInferenceCustomQuotaSection,
  type CheaperInferenceProviderAccount,
  type CheaperInferenceAccountStats,
  type CheaperInferenceQuotaProviderOptions,
} from './quota/cheaperinference.js'
import { PluginSettingsStore } from './settings.js'
import { CheaperInferenceSyncManager } from './sync-manager.js'
import './quota/contract.js'
import './types.js'

const cheaperInferencePreset: ProviderPreset = {
  id: 'cheaperinference',
  name: 'Cheaper Inference',
  description:
    'Access leading discounted AI models from multiple providers through one API with live marketplace rates.',
  documentationUrl: 'https://platform.cheaperinference.com/docs',
  requiresAuth: false,
  transportAdapter: 'cheaperinference-transport',
  authAdapter: 'cheaperinference-auth',
  defaults: {
    name: 'Cheaper Inference',
    url: 'https://api.cheaperinference.com/v1',
    backend: 'openai',
  },
  missingPluginMessage: 'Install openfox-cheaperinference to use this provider.',
}

export { CheaperInferenceAuthAdapter } from './auth/cheaperinference-auth.js'
export { CheaperInferenceTransportAdapter } from './transport/cheaperinference.js'
export { CheaperInferenceSyncManager, type PriceDiff, type SyncManagerOptions } from './sync-manager.js'
export { PluginSettingsStore, DEFAULT_SETTINGS, type CheaperInferencePluginSettings } from './settings.js'
export {
  CheaperInferenceQuotaProvider,
  CheaperInferenceCustomQuotaSection,
  type CheaperInferenceProviderAccount,
  type CheaperInferenceAccountStats,
  type CheaperInferenceQuotaProviderOptions,
} from './quota/cheaperinference.js'

export async function register(registry: ProviderPluginRegistry): Promise<void> {
  const configDir = registry.runtime.configDirectory
  const storageDir = join(configDir, 'plugins', 'openfox-cheaperinference')
  const settingsStore = new PluginSettingsStore(join(storageDir, 'settings.json'))
  const initialSettings = await settingsStore.load()
  const credentials = new FileProviderCredentialStore(
    join(storageDir, 'credentials.json'),
    join(storageDir, 'credentials.key'),
  )
  const auth = new CheaperInferenceAuthAdapter(credentials)
  const transport = new CheaperInferenceTransportAdapter(auth, settingsStore, {
    configDirectory: configDir,
  })
  const notify =
    typeof (registry as any).context?.notify === 'function'
      ? (registry as any).context.notify.bind((registry as any).context)
      : typeof (registry as any).notify === 'function'
        ? (registry as any).notify.bind(registry)
        : undefined

  const syncManager = new CheaperInferenceSyncManager({
    transport,
    settings: initialSettings,
    ...(notify ? { notify } : {}),
  })
  syncManager.start()

  registry.registerAuth(auth)
  registry.registerTransport(transport)
  registry.registerPreset(cheaperInferencePreset)

  const quotaProvider = new CheaperInferenceQuotaProvider(credentials, {
    configDirectory: registry.runtime.configDirectory,
  })
  await quotaProvider.registerProviders(registry as any)

  // Register RPC methods for manual quota sync, retrieval, and balance stats
  if (typeof (registry as any).registerRpc === 'function') {
    ;(registry as any).registerRpc('cheaperinference.getQuota', async (params: any) => {
      const providerId = typeof params?.['providerId'] === 'string' ? params['providerId'] : undefined
      if (providerId) {
        const accounts = await quotaProvider.discoverProviders()
        const target = accounts.find((a) => a.id === providerId || a.sourceId === providerId)
        if (target) {
          const source = await quotaProvider.getQuotaForAccount(target)
          return { source }
        }
      }
      const sources = await quotaProvider.getAllQuotaSources()
      return { sources }
    })

    ;(registry as any).registerRpc('cheaperinference.getBalance', async (params: any) => {
      const providerId = typeof params?.['providerId'] === 'string' ? params['providerId'] : undefined
      const accounts = await quotaProvider.discoverProviders()
      if (providerId) {
        const target = accounts.find((a) => a.id === providerId || a.sourceId === providerId)
        if (target) {
          const stats = await quotaProvider.getStatsForAccount(target)
          return { stats, account: target }
        }
      }
      const statsList = await Promise.all(
        accounts.map(async (acc) => ({
          account: acc,
          stats: await quotaProvider.getStatsForAccount(acc),
        })),
      )
      return { accounts: statsList }
    })

    ;(registry as any).registerRpc('cheaperinference.syncQuota', async () => {
      return await quotaProvider.syncQuota(registry as any)
    })
    ;(registry as any).registerRpc('cheaperinference.manualSync', async () => {
      const { models, priceDiffs } = await syncManager.syncAll()
      notify?.({
        title: {
          en: 'CheaperInference Check Completed',
          fr: 'Vérification CheaperInference terminée',
        },
        body: {
          en: `${models.length} models verified. ${priceDiffs.length} pricing changes.`,
          fr: `${models.length} modèles vérifiés. ${priceDiffs.length} changements de prix.`,
        },
        level: 'success',
      })
      return { success: true, modelsCount: models.length, priceDiffsCount: priceDiffs.length }
    })
  }

  // Register tool for LLM to query Cheaper Inference quotas and balance
  if (typeof (registry as any).registerTool === 'function') {
    ;(registry as any).registerTool({
      name: 'get_cheaperinference_quota',
      description:
        'Retrieve current model quota limits, wallet balance ($), reserved ($), available ($), and estimated saved ($) across all configured Cheaper Inference provider accounts.',
      parameters: {
        type: 'object',
        properties: {
          providerId: {
            type: 'string',
            description: 'Optional Cheaper Inference provider ID or source ID filter',
          },
        },
      },
      execute: async (args: any) => {
        const providerId = typeof args['providerId'] === 'string' ? args['providerId'] : undefined
        if (providerId) {
          const accounts = await quotaProvider.discoverProviders()
          const target = accounts.find((a) => a.id === providerId || a.sourceId === providerId)
          if (target) {
            const source = await quotaProvider.getQuotaForAccount(target)
            const stats = await quotaProvider.getStatsForAccount(target)
            return {
              success: true,
              output: JSON.stringify({ source, stats }, null, 2),
            }
          }
        }
        const accounts = await quotaProvider.discoverProviders()
        const sources = await quotaProvider.getAllQuotaSources()
        const accountsStats = await Promise.all(
          accounts.map(async (acc) => ({
            account: acc,
            stats: await quotaProvider.getStatsForAccount(acc),
          })),
        )
        return {
          success: true,
          output: JSON.stringify({ sources, accounts: accountsStats }, null, 2),
        }
      },
    })
  }

  // Register turn completion hook to keep quotas updated
  if (typeof (registry as any).registerHook === 'function') {
    ;(registry as any).registerHook('turn.completed', async () => {
      try {
        await quotaProvider.syncQuota(registry as any)
      } catch {
        // Silently ignore background quota sync failure
      }
    })
  }

  if (typeof (registry as any).registerSettings === 'function') {
    ;(registry as any).registerSettings({
      title: {
        en: 'Cheaper Inference Configuration',
        fr: 'Configuration Cheaper Inference',
      },
      description: {
        en: 'Configure models discovery, discount display and dynamic API pricing periodic synchronization.',
        fr: 'Configurer la découverte des modèles, l’affichage des réductions et la synchronisation périodique des prix.',
      },
      fields: [
        {
          key: 'showDiscount',
          label: {
            en: 'Show model discount badges & prices',
            fr: 'Afficher les badges de réduction et les prix des modèles',
          },
          type: 'boolean',
          description: {
            en: 'Display marketplace discount badges and calculate discounted rates on model cards and selector.',
            fr: 'Afficher les réductions du marché et calculer les prix réduits sur les cartes de modèles.',
          },
          default: true,
        },
        {
          key: 'checkModelsOnStartup',
          label: {
            en: 'Check models on OpenFox startup',
            fr: 'Vérifier les modèles au démarrage d’OpenFox',
          },
          type: 'boolean',
          description: {
            en: 'Automatically check CheaperInference for new models when OpenFox starts.',
            fr: 'Vérifier automatiquement les nouveaux modèles CheaperInference au démarrage.',
          },
          default: true,
        },
        {
          key: 'modelsRefreshIntervalMinutes',
          label: {
            en: 'Models check interval (minutes)',
            fr: 'Intervalle de vérification des modèles (minutes)',
          },
          type: 'number',
          description: {
            en: 'How often to automatically check CheaperInference for new models (in minutes).',
            fr: 'Fréquence de vérification des nouveaux modèles (en minutes).',
          },
          default: 60,
          required: true,
        },
        {
          key: 'checkPricesOnStartup',
          label: {
            en: 'Check API prices on OpenFox startup',
            fr: 'Vérifier les prix de l’API au démarrage',
          },
          type: 'boolean',
          description: {
            en: 'Automatically check API pricing changes when OpenFox starts.',
            fr: 'Vérifier automatiquement les changements de prix de l’API au démarrage.',
          },
          default: true,
        },
        {
          key: 'pricesRefreshIntervalMinutes',
          label: {
            en: 'Pricing check interval (minutes)',
            fr: 'Intervalle de vérification des prix (minutes)',
          },
          type: 'number',
          description: {
            en: 'How often to automatically check CheaperInference API prices (default: 60 minutes).',
            fr: 'Fréquence de vérification des prix de l’API (par défaut : 60 minutes).',
          },
          default: 60,
          required: true,
        },
        {
          key: 'notifyOnNewModelsOnly',
          label: {
            en: 'Notify only when new models are available or removed',
            fr: 'Notifier uniquement lors de l’ajout ou du retrait de modèles',
          },
          type: 'boolean',
          description: {
            en: 'Receive an in-app notification only when models are added or removed.',
            fr: 'Recevoir une notification uniquement lorsque des modèles sont ajoutés ou retirés.',
          },
          default: true,
        },
        {
          key: 'notifyOnPriceChanges',
          label: {
            en: 'Notify on price modifications',
            fr: 'Notifier en cas de modification des prix',
          },
          type: 'boolean',
          description: {
            en: 'Receive an in-app notification when model API prices change.',
            fr: 'Recevoir une notification lorsque les prix des modèles changent.',
          },
          default: true,
        },
        {
          key: 'notifyOnEveryCheck',
          label: {
            en: 'Notify on every check',
            fr: 'Notifier à chaque vérification',
          },
          type: 'boolean',
          description: {
            en: 'Receive an in-app notification every time the background batch checks models or pricing.',
            fr: 'Recevoir une notification à chaque vérification en arrière-plan.',
          },
          default: false,
        },
        {
          key: 'manualSync',
          label: { en: 'Sync Now', fr: 'Synchroniser' },
          type: 'button',
          buttonLabel: { en: 'Sync Now', fr: 'Synchroniser' },
          rpcMethod: 'cheaperinference.manualSync',
        },
      ],
      async getSettings() {
        return (await settingsStore.load()) as unknown as Record<string, unknown>
      },
      async saveSettings(values: Record<string, unknown>) {
        const updated = await settingsStore.save(values)
        syncManager.updateSettings(updated)
      },
      async executeAction(action: string) {
        if (action === 'manualSync') {
          const { models, priceDiffs } = await syncManager.syncAll()
          const newModels = syncManager.getLastDiscoveredModels()
          const removedModels = syncManager.getLastRemovedModels()
          const parts: string[] = [`${models.length} models available`]
          if (newModels.length > 0) parts.push(`${newModels.length} new: ${newModels.join(', ')}`)
          if (removedModels.length > 0) parts.push(`${removedModels.length} removed: ${removedModels.join(', ')}`)
          if (priceDiffs.length > 0) parts.push(`${priceDiffs.length} price changes`)
          return { message: `Sync complete: ${parts.join(' | ')}.` }
        }
      },
    })
  }
}
