import { join } from 'node:path'
import type { ProviderPluginRegistry, ProviderPreset } from 'openfox/provider'
import { FileProviderCredentialStore } from './credentials/file-credential-store.js'
import { CheaperInferenceAuthAdapter } from './auth/cheaperinference-auth.js'
import { CheaperInferenceTransportAdapter } from './transport/cheaperinference.js'
import { PluginSettingsStore } from './settings.js'
import { CheaperInferenceSyncManager } from './sync-manager.js'
import './types.js'

const cheaperInferencePreset: ProviderPreset = {
  id: 'cheaperinference',
  name: 'Cheaper Inference',
  description: 'Access leading discounted AI models from multiple providers through one API with live marketplace rates.',
  documentationUrl: 'https://platform.cheaperinference.com/docs',
  requiresAuth: false,
  transportAdapter: 'cheaperinference-transport',
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

export async function register(registry: ProviderPluginRegistry): Promise<void> {
  const storageDir = join(registry.runtime.configDirectory, 'plugins', 'openfox-cheaperinference')
  const settingsStore = new PluginSettingsStore(join(storageDir, 'settings.json'))
  const initialSettings = await settingsStore.load()

  const credentials = new FileProviderCredentialStore(
    join(storageDir, 'credentials.json'),
    join(storageDir, 'credentials.key'),
  )
  const auth = new CheaperInferenceAuthAdapter(credentials)
  const transport = new CheaperInferenceTransportAdapter(auth, settingsStore)

  const syncManager = new CheaperInferenceSyncManager({
    transport,
    settings: initialSettings,
    notify: (notification) => {
      if (typeof (registry as any).notify === 'function') {
        ;(registry as any).notify(notification)
      }
    },
  })
  syncManager.start()

  registry.registerAuth(auth)
  registry.registerTransport(transport)
  registry.registerPreset(cheaperInferencePreset)

  if (typeof (registry as any).registerSettings === 'function') {
    ;(registry as any).registerSettings({
      title: 'Cheaper Inference Configuration',
      description: 'Configure models discovery, discount display and dynamic API pricing periodic synchronization.',
      fields: [
        {
          key: 'apiKey',
          label: 'CheaperInference API Key',
          type: 'text',
          description: 'API key (sk-...) used for chat completions and model synchronization.',
          defaultValue: '',
        },
        {
          key: 'showDiscount',
          label: 'Show model discount badges & prices',
          type: 'boolean',
          description: 'Display marketplace discount badges and calculate discounted rates on model cards and selector.',
          defaultValue: true,
        },
        {
          key: 'checkModelsOnStartup',
          label: 'Check models on OpenFox startup',
          type: 'boolean',
          description: 'Automatically check CheaperInference for new models when OpenFox starts.',
          defaultValue: true,
        },
        {
          key: 'modelsRefreshIntervalMinutes',
          label: 'Models check interval (minutes)',
          type: 'number',
          description: 'How often to automatically check CheaperInference for new models (in minutes).',
          defaultValue: 60,
          required: true,
        },
        {
          key: 'checkPricesOnStartup',
          label: 'Check API prices on OpenFox startup',
          type: 'boolean',
          description: 'Automatically check API pricing changes when OpenFox starts.',
          defaultValue: true,
        },
        {
          key: 'pricesRefreshIntervalMinutes',
          label: 'Pricing check interval (minutes)',
          type: 'number',
          description: 'How often to automatically check CheaperInference API prices (default: 60 minutes).',
          defaultValue: 60,
          required: true,
        },
        {
          key: 'notifyOnNewModelsOnly',
          label: 'Notify only when new models are available or removed',
          type: 'boolean',
          description: 'Receive an in-app notification only when models are added or removed.',
          defaultValue: true,
        },
        {
          key: 'notifyOnPriceChanges',
          label: 'Notify on price modifications',
          type: 'boolean',
          description: 'Receive an in-app notification when model API prices change.',
          defaultValue: true,
        },
        {
          key: 'notifyOnEveryCheck',
          label: 'Notify on every check',
          type: 'boolean',
          description: 'Receive an in-app notification every time the background batch checks models or pricing.',
          defaultValue: false,
        },
        {
          key: 'manualSync',
          label: '',
          type: 'button',
          buttonLabel: 'Sync Now',
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
