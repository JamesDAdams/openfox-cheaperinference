import { vi, describe, it, expect, beforeEach } from 'vitest'
import {
  CheaperInferenceQuotaProvider,
  CheaperInferenceCustomQuotaSection,
  CHEAPERINFERENCE_BALANCE_API,
  CHEAPERINFERENCE_SAVINGS_API,
} from './cheaperinference.js'
import { MemoryProviderCredentialStore } from '../credentials/credential-store.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

function makeStore(): MemoryProviderCredentialStore {
  return new MemoryProviderCredentialStore()
}

describe('CheaperInferenceQuotaProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.CHEAPERINFERENCE_API_KEY
    delete process.env.CHEAPER_INFERENCE_API_KEY
    const pendingKey = Symbol.for('openfox.pendingQuotaProviders')
    const globalQuotaKey = Symbol.for('openfox.quotaManager')
    delete (globalThis as any)[pendingKey]
    delete (globalThis as any)[globalQuotaKey]
  })

  it('returns default metrics when no credentials and no env var', async () => {
    const store = makeStore()
    const provider = new CheaperInferenceQuotaProvider(store)
    const quota = await provider.getQuota()

    expect(quota.id).toBe('cheaperinference')
    expect(quota.name).toBe('Cheaper Inference')
    expect(quota.metrics.length).toBe(4)
    expect(quota.metrics[0]).toMatchObject({
      kind: 'currency',
      label: 'Balance',
      amount: 0,
    })
  })

  it('fetches balance from /v1/account/balance and savings from /v1/account/savings', async () => {
    const store = makeStore()
    await store.create({ apiKey: 'sk-test-key' })

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === CHEAPERINFERENCE_BALANCE_API) {
        return {
          ok: true,
          json: async () => ({
            object: 'account.balance',
            currency: 'USD',
            balance_usd: 0.59,
            available_usd: 0.59,
            reserved_usd: 0.0,
            auto_recharge_enabled: false,
          }),
        }
      }
      if (url === CHEAPERINFERENCE_SAVINGS_API) {
        return {
          ok: true,
          json: async () => ({
            object: 'account.savings',
            currency: 'USD',
            windows: [
              {
                days: 30,
                request_count: 140,
                billed_usd: 1.25,
                saved_usd: 7.07,
                list_usd: 8.32,
              },
            ],
          }),
        }
      }
      return { ok: false, status: 404 }
    })

    const provider = new CheaperInferenceQuotaProvider(store, { fetcher: mockFetch as any })
    const accounts = await provider.discoverProviders()
    const stats = await provider.getStatsForAccount(accounts[0]!)

    expect(stats).toBeDefined()
    expect(stats?.balance).toBe(0.59)
    expect(stats?.available).toBe(0.59)
    expect(stats?.reserved).toBe(0.0)
    expect(stats?.saved).toBe(7.07)
    expect(stats?.isLowBalance).toBe(true) // < $1.00 is low balance

    const quota = await provider.getQuota()
    expect(quota.metrics).toHaveLength(4)
    expect(quota.metrics.find((m) => m.label === 'Balance')).toMatchObject({
      kind: 'currency',
      amount: 0.59,
    })
    expect(quota.metrics.find((m) => m.label === 'Reserved')).toMatchObject({
      kind: 'currency',
      amount: 0.0,
    })
    expect(quota.metrics.find((m) => m.label === 'Available')).toMatchObject({
      kind: 'currency',
      amount: 0.59,
    })
    expect(quota.metrics.find((m) => m.label === 'Estimated Saved')).toMatchObject({
      kind: 'currency',
      amount: 7.07,
    })
  })

  it('renders custom quota section with 4 cards and exact values', async () => {
    const store = makeStore()
    await store.create({ apiKey: 'sk-test-key' })

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === CHEAPERINFERENCE_BALANCE_API) {
        return {
          ok: true,
          json: async () => ({
            object: 'account.balance',
            currency: 'USD',
            balance_usd: 0.59,
            available_usd: 0.59,
            reserved_usd: 0.0,
          }),
        }
      }
      if (url === CHEAPERINFERENCE_SAVINGS_API) {
        return {
          ok: true,
          json: async () => ({
            object: 'account.savings',
            windows: [{ days: 30, request_count: 10, saved_usd: 7.07 }],
          }),
        }
      }
      return { ok: false, status: 404 }
    })

    const provider = new CheaperInferenceQuotaProvider(store, { fetcher: mockFetch as any })
    const section = new CheaperInferenceCustomQuotaSection(provider)
    const nodes = await section.render()

    expect(nodes).toHaveLength(1)
    const stackNode = nodes[0] as any
    expect(stackNode.type).toBe('stack')
    expect(stackNode.children).toHaveLength(4)

    // Card 1: Balance $0.59
    const card1 = stackNode.children[0]
    expect(card1.type).toBe('card')
    const card1Texts = card1.children[0].children.map((c: any) => c.text?.en)
    expect(card1Texts[0]).toBe('👛 BALANCE')
    expect(card1Texts[1]).toBe('$0.59')
    expect(card1Texts[2]).toBe('Too low to cover requests')

    // Card 2: Reserved $0.00
    const card2 = stackNode.children[1]
    const card2Texts = card2.children[0].children.map((c: any) => c.text?.en)
    expect(card2Texts[0]).toBe('🔒 RESERVED')
    expect(card2Texts[1]).toBe('$0.00')

    // Card 3: Available $0.59
    const card3 = stackNode.children[2]
    const card3Texts = card3.children[0].children.map((c: any) => c.text?.en)
    expect(card3Texts[0]).toBe('💲 AVAILABLE')
    expect(card3Texts[1]).toBe('$0.59')

    // Card 4: Estimated Saved $7.07
    const card4 = stackNode.children[3]
    const card4Texts = card4.children[0].children.map((c: any) => c.text?.en)
    expect(card4Texts[0]).toBe('🐷 ESTIMATED SAVED')
    expect(card4Texts[1]).toBe('$7.07')
  })

  it('falls back to legacy /v1/user/balance if /v1/account/balance returns 404', async () => {
    const store = makeStore()
    await store.create({ apiKey: 'sk-test-key' })

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === CHEAPERINFERENCE_BALANCE_API) {
        return { ok: false, status: 404 }
      }
      if (url.includes('/v1/user/balance')) {
        return {
          ok: true,
          json: async () => ({
            total_credits: 500,
            credits_remaining: 350,
          }),
        }
      }
      return { ok: false, status: 404 }
    })

    const provider = new CheaperInferenceQuotaProvider(store, { fetcher: mockFetch as any })
    const quota = await provider.getQuota()

    expect(quota.metrics).toHaveLength(1)
    expect(quota.metrics[0]).toMatchObject({
      kind: 'token-balance',
      label: 'Credits Balance',
      total: 500,
      remaining: 350,
    })
  })

  it('discovers providers from config.json, credential store, and env variables', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cheaper-test-'))
    const configPath = path.join(tempDir, 'config.json')

    const store = makeStore()
    const ref = await store.create({ apiKey: 'sk-store-key' })

    await fs.writeFile(
      configPath,
      JSON.stringify({
        providers: [
          {
            id: 'cheaper-pro',
            name: 'Cheaper Inference Pro',
            preset: 'cheaperinference',
            apiKey: 'sk-direct-key',
          },
          {
            id: 'cheaper-user',
            name: 'Cheaper Inference User',
            preset: 'cheaperinference',
            credentialRef: ref,
          },
        ],
      }),
    )

    process.env.CHEAPERINFERENCE_API_KEY = 'sk-env-key'

    const provider = new CheaperInferenceQuotaProvider(store, { configDirectory: tempDir })
    const accounts = await provider.discoverProviders()

    expect(accounts).toHaveLength(3)
    expect(accounts.find((a) => a.id === 'cheaper-pro')).toBeDefined()
    expect(accounts.find((a) => a.id === 'cheaper-user')).toBeDefined()
    expect(accounts.find((a) => a.id === 'cheaperinference-env')).toBeDefined()

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('preserves last-good metrics when a forced refresh fails', async () => {
    const store = makeStore()
    await store.create({ apiKey: 'sk-test-key' })
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          balance_usd: 50.0,
          available_usd: 45.0,
          reserved_usd: 5.0,
        }),
      })
      .mockRejectedValueOnce(new Error('offline'))
    let now = 1000
    const provider = new CheaperInferenceQuotaProvider(store, {
      fetcher: mockFetch as any,
      now: () => now,
    })
    const first = await provider.getQuota()
    now += 61_000
    const second = await provider.getQuota()
    expect(first.metrics).toEqual(second.metrics)
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('removes pushed quota sources when providers are deleted', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cheaper-delete-test-'))
    await fs.writeFile(path.join(tempDir, 'config.json'), JSON.stringify({ providers: [] }))
    const store = makeStore()
    await store.create({ apiKey: 'orphaned-key' })
    const globalQuotaManager = {
      clearPushedSources: vi.fn(),
      submitSource: vi.fn(),
      registerCustomSection: vi.fn(),
    }
    ;(globalThis as any)[Symbol.for('openfox.quotaManager')] = globalQuotaManager
    const provider = new CheaperInferenceQuotaProvider(store, { configDirectory: tempDir })
    const result = await provider.syncQuota()
    expect(result.sources.length).toBeGreaterThan(0)
    expect(globalQuotaManager.clearPushedSources).toHaveBeenCalled()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('registers with openfox-quota pending providers, global quota manager, and custom section', async () => {
    const store = makeStore()
    await store.create({ apiKey: 'sk-key' })

    const submittedSources: any[] = []
    const globalQuotaManager = {
      registerProvider: vi.fn(),
      registerCustomSection: vi.fn(),
      submitSource: (src: any) => submittedSources.push(src),
      clearPushedSources: vi.fn(),
    }
    const globalQuotaKey = Symbol.for('openfox.quotaManager')
    const pendingKey = Symbol.for('openfox.pendingQuotaProviders')
    ;(globalThis as any)[globalQuotaKey] = globalQuotaManager

    const provider = new CheaperInferenceQuotaProvider(store)
    await provider.registerProviders()

    const pending = (globalThis as any)[pendingKey]
    expect(pending).toContain(provider)
    expect(globalQuotaManager.registerProvider).toHaveBeenCalledWith(provider)
    expect(globalQuotaManager.registerCustomSection).toHaveBeenCalled()
  })

  it('provides wallet and piggy bank icons and value display mode on metrics', async () => {
    const store = makeStore()
    const provider = new CheaperInferenceQuotaProvider(store)
    const quota = await provider.getQuota()

    const balance = quota.metrics.find((m) => m.label === 'Balance')
    expect(balance?.icon).toContain('<svg')
    expect(balance?.displayMode).toBe('value')

    const saved = quota.metrics.find((m) => m.label === 'Estimated Saved')
    expect(saved?.icon).toContain('<svg')
    expect(saved?.displayMode).toBe('value')

    const reserved = quota.metrics.find((m) => m.label === 'Reserved')
    expect(reserved?.icon).toContain('<svg')

    const available = quota.metrics.find((m) => m.label === 'Available')
    expect(available?.icon).toContain('<svg')
  })
})
