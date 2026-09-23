import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ProviderCredentialStore } from '../credentials/credential-store.js'
import type { CheaperInferenceCredential } from '../auth/cheaperinference-auth.js'
import type {
  QuotaProvider,
  QuotaSource,
  QuotaMetric,
  PluginRegistry,
  CustomQuotaSection,
  DeclarativeNode,
} from './contract.js'

export const CHEAPERINFERENCE_BALANCE_API = 'https://api.cheaperinference.com/v1/account/balance'
export const CHEAPERINFERENCE_SAVINGS_API = 'https://api.cheaperinference.com/v1/account/savings'
export const CHEAPERINFERENCE_USAGE_DAILY_API = 'https://api.cheaperinference.com/v1/usage/daily'
export const CHEAPERINFERENCE_USAGE_REQUESTS_API = 'https://api.cheaperinference.com/v1/usage/requests'
export const CHEAPERINFERENCE_LEGACY_BALANCE_API = 'https://api.cheaperinference.com/v1/user/balance'

export const WALLET_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/></svg>'

export const PIGGY_BANK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 5c-1.5 0-2.8 1.4-3 2-3.5-1.5-11-.3-11 5 0 1.8 0 3 2 4.5V20h4v-2h3v2h4v-4c1-.5 1.7-1 2-2h2v-4h-2c0-1-.5-1.5-1-2h0V5z"/><path d="M2 9v1c0 1.1.9 2 2 2h1"/><circle cx="7" cy="11" r="1"/></svg>'

export const LOCK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'

export const DOLLAR_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>'

const CACHE_TTL_MS = 60_000
const STALE_CACHE_TTL_MS = 5 * 60_000

const GLOBAL_QUOTA_KEY = Symbol.for('openfox.quotaManager')
const PENDING_PROVIDERS_KEY = Symbol.for('openfox.pendingQuotaProviders')

export interface CheaperInferenceProviderAccount {
  id: string
  name: string
  apiKey?: string
  url?: string
  sourceId: string
  isDefault?: boolean
}

export interface CheaperInferenceAccountStats {
  balance: number
  available: number
  reserved: number
  saved: number
  billed?: number
  currency: string
  autoRechargeEnabled?: boolean
  threshold?: number | null
  rechargeAmount?: number | null
  isLowBalance: boolean
  isCredits?: boolean
  scopeRequired?: string
  updatedAt: number
}

export interface CheaperInferenceQuotaProviderOptions {
  fetcher?: typeof fetch
  now?: () => number
  configDirectory?: string
}

interface CacheEntry {
  metrics: QuotaMetric[]
  stats?: CheaperInferenceAccountStats
  name: string
  cachedAt: number
}

function getCandidateConfigDirs(explicitDir?: string): string[] {
  if (explicitDir) {
    return [explicitDir]
  }
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return []
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

export class CheaperInferenceCustomQuotaSection implements CustomQuotaSection {
  readonly id = 'cheaperinference-custom'
  readonly title = {
    en: 'Cheaper Inference Account & Balance',
    fr: 'Compte & Solde Cheaper Inference',
  }
  readonly order = 15

  constructor(private readonly provider: CheaperInferenceQuotaProvider) {}

  async render(): Promise<DeclarativeNode[]> {
    let accounts = await this.provider.discoverProviders()
    if (accounts.length === 0) {
      accounts = [
        {
          id: 'cheaperinference',
          name: 'Cheaper Inference',
          sourceId: 'cheaperinference',
        },
      ]
    }

    const cardsByAccount: DeclarativeNode[] = []

    for (const account of accounts) {
      let stats = await this.provider.getStatsForAccount(account)
      if (!stats) {
        stats = {
          balance: 0,
          available: 0,
          reserved: 0,
          saved: 0,
          currency: 'USD',
          isLowBalance: true,
          updatedAt: this.provider.getNow(),
        }
      }

      const balanceFormatted = stats.isCredits
        ? `${Math.round(stats.balance).toLocaleString('en-US')}`
        : `$${stats.balance.toFixed(2)}`
      const reservedFormatted = stats.isCredits
        ? `${Math.round(stats.reserved).toLocaleString('en-US')}`
        : `$${stats.reserved.toFixed(2)}`
      const availableFormatted = stats.isCredits
        ? `${Math.round(stats.available).toLocaleString('en-US')}`
        : `$${stats.available.toFixed(2)}`
      const savedFormatted = stats.isCredits
        ? `${Math.round(stats.saved).toLocaleString('en-US')}`
        : `$${stats.saved.toFixed(2)}`

      const balanceColorClass = stats.isLowBalance ? 'text-accent-error' : 'text-text-primary'
      const balanceSubtitleText = stats.scopeRequired
        ? { en: "API key requires 'account:read' scope", fr: "La clé nécessite la permission 'account:read'" }
        : stats.isLowBalance
          ? { en: 'Too low to cover requests', fr: 'Trop bas pour couvrir les requêtes' }
          : { en: 'Account total balance', fr: 'Solde total du compte' }
      const balanceSubtitleClass = stats.isLowBalance || stats.scopeRequired
        ? 'text-xs text-accent-error font-medium'
        : 'text-xs text-text-muted'

      const availableSubtitleText = stats.scopeRequired
        ? { en: 'Enable scope in CheaperInference keys', fr: "Activer 'account:read' sur CheaperInference" }
        : { en: 'Balance you can still spend', fr: 'Solde restant utilisable' }

      const accountNodes: DeclarativeNode = {
        type: 'stack',
        direction: 'row',
        gap: 'sm',
        className: 'grid grid-cols-4 w-full gap-2',
        children: [
          // Card 1: BALANCE
          {
            type: 'card',
            children: [
              {
                type: 'stack',
                direction: 'column',
                gap: 'xs',
                className: 'w-full',
                children: [
                  {
                    type: 'text',
                    text: { en: '👛 BALANCE', fr: '👛 SOLDE' },
                    className: 'text-xs font-mono font-medium tracking-wider text-text-muted',
                  },
                  {
                    type: 'text',
                    text: { en: balanceFormatted, fr: balanceFormatted },
                    className: `text-2xl sm:text-3xl font-mono font-bold leading-tight ${balanceColorClass}`,
                  },
                  {
                    type: 'text',
                    text: balanceSubtitleText,
                    className: balanceSubtitleClass,
                  },
                ],
              },
            ],
          },
          // Card 2: RESERVED
          {
            type: 'card',
            children: [
              {
                type: 'stack',
                direction: 'column',
                gap: 'xs',
                className: 'w-full',
                children: [
                  {
                    type: 'text',
                    text: { en: '🔒 RESERVED', fr: '🔒 RÉSERVÉ' },
                    className: 'text-xs font-mono font-medium tracking-wider text-text-muted',
                  },
                  {
                    type: 'text',
                    text: { en: reservedFormatted, fr: reservedFormatted },
                    className: 'text-2xl sm:text-3xl font-mono font-bold text-text-primary leading-tight',
                  },
                  {
                    type: 'text',
                    text: { en: 'Held for requests in flight', fr: 'Réservé pour requêtes en cours' },
                    className: 'text-xs text-text-muted',
                  },
                ],
              },
            ],
          },
          // Card 3: AVAILABLE
          {
            type: 'card',
            children: [
              {
                type: 'stack',
                direction: 'column',
                gap: 'xs',
                className: 'w-full',
                children: [
                  {
                    type: 'text',
                    text: { en: '💲 AVAILABLE', fr: '💲 DISPONIBLE' },
                    className: 'text-xs font-mono font-medium tracking-wider text-text-muted',
                  },
                  {
                    type: 'text',
                    text: { en: availableFormatted, fr: availableFormatted },
                    className: `text-2xl sm:text-3xl font-mono font-bold leading-tight ${
                      stats.isLowBalance ? 'text-accent-error' : 'text-accent-success'
                    }`,
                  },
                  {
                    type: 'text',
                    text: availableSubtitleText,
                    className: 'text-xs text-text-muted',
                  },
                ],
              },
            ],
          },
          // Card 4: ESTIMATED SAVED
          {
            type: 'card',
            children: [
              {
                type: 'stack',
                direction: 'column',
                gap: 'xs',
                className: 'w-full',
                children: [
                  {
                    type: 'text',
                    text: { en: '🐷 ESTIMATED SAVED', fr: '🐷 ÉCONOMIES ESTIMÉES' },
                    className: 'text-xs font-mono font-medium tracking-wider text-text-muted',
                  },
                  {
                    type: 'text',
                    text: { en: savedFormatted, fr: savedFormatted },
                    className: 'text-2xl sm:text-3xl font-mono font-bold text-accent-success leading-tight',
                  },
                  {
                    type: 'text',
                    text: { en: 'vs. provider list prices', fr: 'par rapport aux prix publics' },
                    className: 'text-xs text-text-muted',
                  },
                ],
              },
            ],
          },
        ],
      }

      if (accounts.length > 1) {
        cardsByAccount.push({
          type: 'card',
          title: { en: account.name, fr: account.name },
          children: [accountNodes],
        })
      } else {
        cardsByAccount.push(accountNodes)
      }
    }

    return cardsByAccount
  }
}

export class CheaperInferenceQuotaProvider implements QuotaProvider {
  readonly id = 'cheaperinference'
  readonly name = 'Cheaper Inference'

  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly configDirectory?: string
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly credentials: ProviderCredentialStore,
    options: CheaperInferenceQuotaProviderOptions = {},
  ) {
    this.request = options.fetcher ?? fetch
    this.now = options.now ?? Date.now
    this.configDirectory = options.configDirectory
  }

  getNow(): number {
    return this.now()
  }

  getDefaultMetrics(): QuotaMetric[] {
    return [
      {
        kind: 'currency',
        label: 'Balance',
        amount: 0,
        currency: 'USD',
        tone: 'danger',
        subtitle: { en: 'Too low to cover requests', fr: 'Trop bas pour couvrir les requêtes' },
        icon: WALLET_ICON_SVG,
        displayMode: 'value',
      },
      {
        kind: 'currency',
        label: 'Reserved',
        amount: 0,
        currency: 'USD',
        tone: 'info',
        subtitle: { en: 'Held for requests in flight', fr: 'Réservé pour requêtes en cours' },
        icon: LOCK_ICON_SVG,
        displayMode: 'value',
      },
      {
        kind: 'currency',
        label: 'Available',
        amount: 0,
        currency: 'USD',
        tone: 'danger',
        subtitle: { en: 'Balance you can still spend', fr: 'Solde restant utilisable' },
        icon: DOLLAR_ICON_SVG,
        displayMode: 'value',
      },
      {
        kind: 'currency',
        label: 'Estimated Saved',
        amount: 0,
        currency: 'USD',
        tone: 'success',
        subtitle: { en: 'vs. provider list prices', fr: 'par rapport aux prix publics' },
        icon: PIGGY_BANK_ICON_SVG,
        displayMode: 'value',
      },
    ]
  }

  /**
   * Discover all CheaperInference provider accounts configured in OpenFox
   * (config.json providers, credential store, environment variables).
   */
  async discoverProviders(): Promise<CheaperInferenceProviderAccount[]> {
    const discovered: CheaperInferenceProviderAccount[] = []
    const seenKeys = new Set<string>()
    const seenIds = new Set<string>()
    let activeCredRefs: Set<string> | null = null
    let hasConfigProviders = false

    // 1. Scan candidate OpenFox config.json directories
    const candidateDirs = getCandidateConfigDirs(this.configDirectory)
    for (const dir of candidateDirs) {
      try {
        const configPath = join(dir, 'config.json')
        const raw = await readFile(configPath, 'utf8')
        const data = JSON.parse(raw)
        if (Array.isArray(data.providers)) {
          hasConfigProviders = true
          activeCredRefs = new Set()
          for (const p of data.providers) {
            if (!p || typeof p !== 'object') continue
            const backend = String(p.backend || '').toLowerCase()
            const transport = String(p.transport || p.transportAdapter || '').toLowerCase()
            const preset = String(p.preset || '').toLowerCase()
            const authAdapter = String(p.authAdapter || '').toLowerCase()
            const url = String(p.url || '').toLowerCase()
            const name = String(p.name || '').toLowerCase()
            const id = String(p.id || '').toLowerCase()

            const isCheaper =
              preset === 'cheaperinference' ||
              backend === 'cheaperinference' ||
              transport === 'cheaperinference-transport' ||
              authAdapter === 'cheaperinference-auth' ||
              url.includes('cheaperinference') ||
              name.includes('cheaper') ||
              id.includes('cheaper')

            if (isCheaper) {
              let key = p.apiKey ? String(p.apiKey) : undefined
              if (p.credentialRef) {
                activeCredRefs.add(String(p.credentialRef))
                if (!key) {
                  try {
                    const cred = (await this.credentials.get(String(p.credentialRef))) as CheaperInferenceCredential | undefined
                    if (cred?.apiKey) {
                      key = cred.apiKey
                    }
                  } catch {
                    // Ignore credential lookup error
                  }
                }
              }

              if (!key) {
                const envKey = process.env.CHEAPERINFERENCE_API_KEY || process.env.CHEAPER_INFERENCE_API_KEY
                if (envKey) key = envKey
              }

              if (!seenIds.has(String(p.id))) {
                seenIds.add(String(p.id))
                if (key) seenKeys.add(key)
                discovered.push({
                  id: String(p.id),
                  name: String(p.name || p.id || 'Cheaper Inference'),
                  apiKey: key,
                  url: p.url ? String(p.url) : undefined,
                  sourceId: String(p.id),
                })
              }
            }
          }
          break
        }
      } catch {
        // Ignore file read / parse error
      }
    }

    // 2. Scan plugin credential store (only include credentials that belong to active providers, or if no config providers list)
    try {
      if (typeof this.credentials.listReferences === 'function') {
        const references = await this.credentials.listReferences()
        for (const ref of references) {
          if (hasConfigProviders && activeCredRefs && !activeCredRefs.has(ref)) {
            // Credential belongs to a deleted/inactive provider
            continue
          }
          const cred = (await this.credentials.get(ref)) as CheaperInferenceCredential | undefined
          if (cred?.apiKey && !seenKeys.has(cred.apiKey)) {
            seenKeys.add(cred.apiKey)
            const credId = `cheaperinference-cred-${ref}`
            const name = `Cheaper Inference (${ref.slice(0, 8)})`
            if (!seenIds.has(credId)) {
              seenIds.add(credId)
              discovered.push({
                id: credId,
                name,
                apiKey: cred.apiKey,
                sourceId: credId,
              })
            }
          }
        }
      }
    } catch {
      // Ignore credential read error
    }

    // 3. Scan environment variables
    const envKey = process.env.CHEAPERINFERENCE_API_KEY || process.env.CHEAPER_INFERENCE_API_KEY
    if (envKey && !seenKeys.has(envKey)) {
      seenKeys.add(envKey)
      const envId = 'cheaperinference-env'
      if (!seenIds.has(envId)) {
        seenIds.add(envId)
        discovered.push({
          id: envId,
          name: 'Cheaper Inference (Env)',
          apiKey: envKey,
          sourceId: envId,
        })
      }
    }

    return discovered
  }

  /**
   * Fetch detailed account stats (balance, reserved, available, saved) for an account.
   */
  async getStatsForAccount(account: CheaperInferenceProviderAccount): Promise<CheaperInferenceAccountStats | undefined> {
    const cached = this.cache.get(account.id)
    if (cached?.stats && this.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.stats
    }

    if (!account.apiKey) {
      return cached?.stats
    }

    try {
      const stats = await this.fetchAccountData(account.apiKey)
      if (stats) {
        const metrics = this.statsToMetrics(stats)
        this.cache.set(account.id, {
          metrics,
          stats,
          name: account.name,
          cachedAt: this.now(),
        })
        return stats
      }
    } catch {
      // Direct call failed
    }

    return cached?.stats
  }

  /**
   * Fetch quota metrics for a single provider account.
   */
  async getQuotaForAccount(account: CheaperInferenceProviderAccount): Promise<QuotaSource> {
    const source: QuotaSource = {
      id: account.sourceId,
      name: account.name,
      metrics: [],
    }

    try {
      const cached = this.cache.get(account.id)
      if (cached && this.now() - cached.cachedAt < CACHE_TTL_MS) {
        return {
          ...source,
          name: cached.name || source.name,
          metrics: cached.metrics,
        }
      }

      let metrics: QuotaMetric[] = []
      let stats: CheaperInferenceAccountStats | undefined
      let fetchedSuccessfully = false

      if (account.apiKey) {
        try {
          stats = await this.fetchAccountData(account.apiKey)
          if (stats) {
            metrics = this.statsToMetrics(stats)
            fetchedSuccessfully = true
          }
        } catch {
          // Direct endpoint failed; last-good cache is retained below.
        }
      }

      if (!fetchedSuccessfully || metrics.length === 0) {
        const lastGood = this.cache.get(account.id)
        if (
          lastGood?.metrics.length &&
          this.now() - lastGood.cachedAt < STALE_CACHE_TTL_MS
        ) {
          return { ...source, name: lastGood.name, metrics: lastGood.metrics }
        }
        // Fall back to default metrics so provider card always displays
        metrics = this.getDefaultMetrics()
      }

      this.cache.set(account.id, {
        metrics,
        stats,
        name: source.name,
        cachedAt: this.now(),
      })

      return { ...source, metrics }
    } catch (error) {
      console.warn(`Cheaper Inference quota unavailable (${account.name})`, {
        error: error instanceof Error ? error.message : String(error),
      })
      const cached = this.cache.get(account.id)
      if (cached) {
        return { ...source, name: cached.name, metrics: cached.metrics }
      }
      return { ...source, metrics: this.getDefaultMetrics() }
    }
  }

  /**
   * Fetch and aggregate quota sources across all discovered Cheaper Inference provider accounts.
   */
  async getAllQuotaSources(): Promise<QuotaSource[]> {
    const accounts = await this.discoverProviders()
    if (accounts.length === 0) {
      return [
        {
          id: this.id,
          name: this.name,
          metrics: this.getDefaultMetrics(),
        },
      ]
    }
    const sources = await Promise.all(accounts.map((acc) => this.getQuotaForAccount(acc)))
    return sources
  }

  /**
   * Main getQuota method implementing QuotaProvider contract.
   * Submits all discovered sources to openfox-quota manager and returns primary source.
   */
  async getQuota(): Promise<QuotaSource> {
    const accounts = await this.discoverProviders()
    if (accounts.length === 0) {
      const defaultSource: QuotaSource = {
        id: this.id,
        name: this.name,
        metrics: this.getDefaultMetrics(),
      }
      this.submitSourcesToGlobalManager(accounts, [defaultSource])
      return defaultSource
    }
    const sources = await Promise.all(accounts.map((acc) => this.getQuotaForAccount(acc)))

    // Submit all sources in openfox-quota
    this.submitSourcesToGlobalManager(accounts, sources)

    const firstWithMetrics = sources.find((s) => s.metrics && s.metrics.length > 0)
    if (firstWithMetrics) {
      return firstWithMetrics
    }
    return sources[0] ?? { id: this.id, name: this.name, metrics: this.getDefaultMetrics() }
  }

  /**
   * Synchronize quota sources with openfox-quota plugin.
   */
  async syncQuota(registry?: PluginRegistry): Promise<{ success: boolean; sources: QuotaSource[] }> {
    this.cache.clear()
    const accounts = await this.discoverProviders()
    const sources = accounts.length > 0
      ? await Promise.all(accounts.map((acc) => this.getQuotaForAccount(acc)))
      : [
          {
            id: this.id,
            name: this.name,
            metrics: this.getDefaultMetrics(),
          },
        ]

    this.submitSourcesToGlobalManager(accounts, sources)

    if (registry) {
      await this.registerProviders(registry)
    }

    return { success: true, sources }
  }

  /**
   * Create a CustomQuotaSection instance for declarative UI rendering.
   */
  createCustomQuotaSection(): CustomQuotaSection {
    return new CheaperInferenceCustomQuotaSection(this)
  }

  /**
   * Register with openfox-quota (via pending list, global manager, registry).
   */
  async registerProviders(registry?: PluginRegistry): Promise<void> {
    const customSection = this.createCustomQuotaSection()

    // 1. Put in pending list so openfox-quota picks it up whenever it loads
    const pending = ((globalThis as any)[PENDING_PROVIDERS_KEY] ??= [])
    if (!pending.some((p: any) => p && p.id === this.id)) {
      pending.push(this)
    }

    // 2. Register with openfox-quota via global quota manager if present (idempotently)
    const globalMgr = (globalThis as any)[GLOBAL_QUOTA_KEY]
    if (globalMgr && typeof globalMgr.registerProvider === 'function') {
      const registered = typeof globalMgr.getProviders === 'function'
        ? globalMgr.getProviders().some((p: any) => p?.id === this.id)
        : Boolean(globalMgr.__cheaperInferenceRegistered)
      if (!registered) {
        globalMgr.registerProvider(this)
        globalMgr.__cheaperInferenceRegistered = true
      }
    }
    if (globalMgr && typeof globalMgr.registerCustomSection === 'function') {
      globalMgr.registerCustomSection(customSection)
    }

    // 3. Register via registry.registerQuotaProvider / registerCustomQuotaSection if present
    if (registry && typeof registry.registerQuotaProvider === 'function') {
      registry.registerQuotaProvider(this)
    }
    if (registry && typeof registry.registerCustomQuotaSection === 'function') {
      registry.registerCustomQuotaSection(customSection)
    }
  }

  private submitSourcesToGlobalManager(
    _accounts: CheaperInferenceProviderAccount[],
    sources: QuotaSource[],
  ): void {
    const globalMgr = (globalThis as any)[GLOBAL_QUOTA_KEY]
    if (!globalMgr) return

    if (typeof globalMgr.clearPushedSources === 'function') {
      globalMgr.clearPushedSources((id: string) => id.startsWith('cheaperinference') || id.includes('cheaper'))
    } else if (globalMgr.pushedSources instanceof Map) {
      for (const key of Array.from(globalMgr.pushedSources.keys())) {
        if (typeof key === 'string' && (key.startsWith('cheaperinference') || key.includes('cheaper'))) {
          globalMgr.pushedSources.delete(key)
        }
      }
    }

    for (const src of sources) {
      if (!src || !src.metrics || src.metrics.length === 0) continue
      if (typeof globalMgr.submitSource === 'function') {
        globalMgr.submitSource(src)
      }
    }
  }

  /**
   * Fetch balance and savings from CheaperInference API endpoints.
   */
  private async fetchAccountData(apiKey: string): Promise<CheaperInferenceAccountStats | undefined> {
    const cleanKey = apiKey.trim()
    const headers: Record<string, string> = {
      Authorization: cleanKey.startsWith('Bearer ') ? cleanKey : `Bearer ${cleanKey}`,
      'X-Api-Key': cleanKey.replace(/^Bearer\s+/i, ''),
      Accept: 'application/json',
      'User-Agent': 'OpenFox',
    }

    // 1. Try /v1/account/balance
    let balanceData: any
    let balanceOk = false
    let scopeRequired: string | undefined

    try {
      const res = await this.request(CHEAPERINFERENCE_BALANCE_API, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        balanceData = await res.json()
        balanceOk = true
      } else if (res.status === 403) {
        try {
          const errBody = await res.json()
          if (errBody?.error?.param === 'account:read' || errBody?.error?.message?.includes('account:read')) {
            scopeRequired = 'account:read'
          }
        } catch {}
      } else if (res.status === 404) {
        const fallbackRes = await this.request(CHEAPERINFERENCE_LEGACY_BALANCE_API, {
          headers,
          signal: AbortSignal.timeout(5000),
        })
        if (fallbackRes.ok) {
          balanceData = await fallbackRes.json()
          balanceOk = true
        }
      }
    } catch {
      // Try legacy fallback on network error
      try {
        const fallbackRes = await this.request(CHEAPERINFERENCE_LEGACY_BALANCE_API, {
          headers,
          signal: AbortSignal.timeout(5000),
        })
        if (fallbackRes.ok) {
          balanceData = await fallbackRes.json()
          balanceOk = true
        }
      } catch {}
    }

    // 2. Try /v1/account/savings
    let savingsData: any
    try {
      const savingsRes = await this.request(CHEAPERINFERENCE_SAVINGS_API, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (savingsRes.ok) {
        savingsData = await savingsRes.json()
      }
    } catch {}

    // 3. If account endpoints are forbidden due to missing account:read scope, try usage endpoints
    if (!balanceOk && scopeRequired) {
      try {
        const [dailyRes, reqsRes] = await Promise.all([
          this.request(CHEAPERINFERENCE_USAGE_DAILY_API, { headers, signal: AbortSignal.timeout(5000) }).catch(() => null),
          this.request(`${CHEAPERINFERENCE_USAGE_REQUESTS_API}?limit=50`, { headers, signal: AbortSignal.timeout(5000) }).catch(() => null),
        ])

        let spend = 0
        let saved = 0
        if (dailyRes && dailyRes.ok) {
          const dailyData = (await dailyRes.json()) as any
          spend = this.firstNumber(dailyData?.spend_usd, dailyData?.spend) ?? 0
        }
        if (reqsRes && reqsRes.ok) {
          const reqsData = (await reqsRes.json()) as any
          if (Array.isArray(reqsData?.data)) {
            for (const r of reqsData.data) {
              const rSaved = this.firstNumber(r?.savings_usd, r?.savings) ?? 0
              saved += rSaved
            }
          }
        }

        return {
          balance: 0,
          available: 0,
          reserved: 0,
          saved: Math.round(saved * 100) / 100,
          billed: Math.round(spend * 100) / 100,
          currency: 'USD',
          isLowBalance: true,
          scopeRequired,
          updatedAt: this.now(),
        }
      } catch {}
    }

    if (!balanceOk && !balanceData) {
      return undefined
    }

    return this.parseAccountStats(balanceData, savingsData)
  }

  /**
   * Parse balance and savings response into CheaperInferenceAccountStats.
   */
  parseAccountStats(balanceData: any, savingsData?: any): CheaperInferenceAccountStats | undefined {
    if (!balanceData || typeof balanceData !== 'object') return undefined

    const root = balanceData.data ?? balanceData.result ?? balanceData
    const container = root.credits ?? root.balance ?? root.usage ?? root

    const hasLegacyCredits =
      (container.total_credits !== undefined ||
        container.credits_remaining !== undefined ||
        root.total_credits !== undefined ||
        root.credits_remaining !== undefined) &&
      root.balance_usd === undefined &&
      container.balance_usd === undefined

    const balanceUsd = this.firstNumber(
      root.balance_usd,
      container.balance_usd,
      container.balance,
      root.balance,
      root.total_credits,
      container.total_credits,
    )

    const availableUsd = this.firstNumber(
      root.available_usd,
      container.available_usd,
      container.available,
      root.available,
      container.credits_remaining,
      root.credits_remaining,
      balanceUsd,
    )

    const reservedUsd = this.firstNumber(
      root.reserved_usd,
      container.reserved_usd,
      container.reserved,
      root.reserved,
      0,
    ) ?? 0

    const threshold = this.firstNumber(
      root.threshold_usd,
      container.threshold_usd,
      root.threshold,
    ) ?? null

    const rechargeAmount = this.firstNumber(
      root.recharge_amount_usd,
      container.recharge_amount_usd,
      root.recharge_amount,
    ) ?? null

    const autoRecharge = Boolean(root.auto_recharge_enabled ?? container.auto_recharge_enabled)

    // Parse savings from savingsData or container
    let savedUsd = 0
    let billedUsd: number | undefined

    if (savingsData && typeof savingsData === 'object') {
      const sRoot = savingsData.data ?? savingsData.result ?? savingsData
      if (Array.isArray(sRoot.windows) && sRoot.windows.length > 0) {
        // Find 30-day window or window with largest saved_usd or largest days
        const win30 = sRoot.windows.find((w: any) => w?.days === 30) ??
          sRoot.windows.reduce((max: any, w: any) => ((w?.saved_usd ?? 0) > (max?.saved_usd ?? 0) ? w : max), sRoot.windows[0])
        if (win30) {
          savedUsd = this.firstNumber(win30.saved_usd, win30.saved) ?? 0
          billedUsd = this.firstNumber(win30.billed_usd, win30.billed)
        }
      } else if (sRoot.saved_usd !== undefined) {
        savedUsd = this.firstNumber(sRoot.saved_usd) ?? 0
      }
    }

    if (savedUsd === 0) {
      savedUsd = this.firstNumber(
        root.saved_usd,
        container.saved_usd,
        root.estimated_saved,
        container.estimated_saved,
        root.savings,
        0,
      ) ?? 0
    }

    const finalBalance = balanceUsd ?? availableUsd ?? 0
    const finalAvailable = availableUsd ?? finalBalance
    const isLowBalance = finalAvailable < 1.0 || (threshold !== null && finalAvailable <= threshold)

    return {
      balance: finalBalance,
      available: finalAvailable,
      reserved: reservedUsd,
      saved: savedUsd,
      billed: billedUsd,
      currency: String(root.currency || 'USD'),
      autoRechargeEnabled: autoRecharge,
      threshold,
      rechargeAmount,
      isLowBalance,
      isCredits: hasLegacyCredits,
      updatedAt: this.now(),
    }
  }

  /**
   * Convert account stats into standard QuotaMetric[] items.
   */
  private statsToMetrics(stats: CheaperInferenceAccountStats): QuotaMetric[] {
    const metrics: QuotaMetric[] = []

    if (stats.isCredits) {
      metrics.push({
        kind: 'token-balance',
        label: 'Credits Balance',
        total: Math.round(stats.balance),
        remaining: Math.round(Math.max(0, Math.min(stats.balance, stats.available))),
      })
      return metrics
    }

    const balanceSubtitle = stats.scopeRequired
      ? { en: "API key requires 'account:read' scope", fr: "La clé nécessite la permission 'account:read'" }
      : stats.isLowBalance
        ? { en: 'Too low to cover requests', fr: 'Trop bas pour couvrir les requêtes' }
        : { en: 'Account total balance', fr: 'Solde total du compte' }

    const availableSubtitle = stats.scopeRequired
      ? { en: "Enable 'account:read' in CheaperInference keys", fr: "Activer 'account:read' sur CheaperInference" }
      : { en: 'Balance you can still spend', fr: 'Solde restant utilisable' }

    // 1. Balance
    metrics.push({
      kind: 'currency',
      label: 'Balance',
      amount: stats.balance,
      currency: stats.currency || 'USD',
      tone: stats.isLowBalance || Boolean(stats.scopeRequired) ? 'danger' : 'info',
      subtitle: balanceSubtitle,
      icon: WALLET_ICON_SVG,
      displayMode: 'value',
    })

    // 2. Reserved
    metrics.push({
      kind: 'currency',
      label: 'Reserved',
      amount: stats.reserved,
      currency: stats.currency || 'USD',
      tone: 'info',
      subtitle: { en: 'Held for requests in flight', fr: 'Réservé pour requêtes en cours' },
      icon: LOCK_ICON_SVG,
      displayMode: 'value',
    })

    // 3. Available
    metrics.push({
      kind: 'currency',
      label: 'Available',
      amount: stats.available,
      currency: stats.currency || 'USD',
      tone: stats.isLowBalance || Boolean(stats.scopeRequired) ? 'danger' : 'success',
      subtitle: availableSubtitle,
      icon: DOLLAR_ICON_SVG,
      displayMode: 'value',
    })

    // 4. Estimated Saved
    metrics.push({
      kind: 'currency',
      label: 'Estimated Saved',
      amount: stats.saved,
      currency: stats.currency || 'USD',
      tone: 'success',
      subtitle: { en: 'vs. provider list prices', fr: 'par rapport aux prix publics' },
      icon: PIGGY_BANK_ICON_SVG,
      displayMode: 'value',
    })

    return metrics
  }

  private firstNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) return parsed
      }
    }
    return undefined
  }
}
