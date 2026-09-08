import { describe, it, expect, vi } from 'vitest'
import { CheaperInferenceSyncManager, formatPriceDiffBody } from './sync-manager.js'
import type { ModelConfig } from 'openfox/provider'

describe('CheaperInferenceSyncManager notification formatting', () => {
  it('formats single model price change with input/output differences', () => {
    const body = formatPriceDiffBody([
      {
        modelId: 'openai/gpt-4o',
        oldPricing: { input: 5, output: 15 },
        newPricing: { input: 2.5, output: 10 },
      },
    ])
    expect(body).toBe('openai/gpt-4o:\n• In: $5.000 → $2.500\n• Out: $15.000 → $10.000')
  })

  it('formats discount / promo changes with rounded percentages', () => {
    const body = formatPriceDiffBody([
      {
        modelId: 'anthropic/claude-3-5-sonnet',
        oldPricing: { input: 3, output: 15, discount: 10.4 },
        newPricing: { input: 3, output: 15, discount: 20.8 },
      },
    ])
    expect(body).toBe('anthropic/claude-3-5-sonnet:\n• Promo: 10% → 21%')
  })

  it('formats price and promo changes together', () => {
    const body = formatPriceDiffBody([
      {
        modelId: 'deepseek/deepseek-r1',
        oldPricing: { input: 0.55, output: 2.19 },
        newPricing: { input: 0.4, output: 2.0, discount: 15 },
      },
    ])
    expect(body).toBe('deepseek/deepseek-r1:\n• In: $0.550 → $0.400\n• Out: $2.190 → $2.000\n• Promo: none → 15%')
  })

  it('formats micro-prices accurately rounded up to 3 decimals', () => {
    const body = formatPriceDiffBody([
      {
        modelId: 'deepseek-v4-flash',
        oldPricing: { input: 0.068918, output: 0.137836 },
        newPricing: { input: 0.067677, output: 0.135355 },
      },
    ])
    // 0.068918 -> ceil to 3 dec: 0.069, 0.067677 -> 0.068
    // 0.137836 -> 0.138, 0.135355 -> 0.136
    expect(body).toBe('deepseek-v4-flash:\n• In: $0.069 → $0.068\n• Out: $0.138 → $0.136')
  })

  it('handles edge micro prices rounding to zero safely without dangling dots', () => {
    const body = formatPriceDiffBody([
      {
        modelId: 'free-model',
        oldPricing: { input: 0 },
        newPricing: { input: 0 },
      },
    ])
    expect(body).toBe('free-model:\n• Pricing updated')
  })

  it('formats multiple models with clean separation and truncation', () => {
    const diffs = [
      {
        modelId: 'model-1',
        oldPricing: { input: 1 },
        newPricing: { input: 2 },
      },
      {
        modelId: 'model-2',
        oldPricing: { discount: 5 },
        newPricing: { discount: 10 },
      },
      {
        modelId: 'model-3',
        oldPricing: { output: 10 },
        newPricing: { output: 8 },
      },
      {
        modelId: 'model-4',
        oldPricing: { input: 2 },
        newPricing: { input: 1 },
      },
    ]
    const body = formatPriceDiffBody(diffs, 2)
    expect(body).toBe(
      'model-1:\n• In: $1.000 → $2.000\n\nmodel-2:\n• Promo: 5% → 10%\n\n(+2 others)',
    )
  })

  it('sends enriched notification during syncAll', async () => {
    const notifyMock = vi.fn()
    const mockTransport = {
      listModels: vi.fn(),
    } as any

    const syncManager = new CheaperInferenceSyncManager({
      transport: mockTransport,
      settings: {
        checkModelsOnStartup: true,
        modelsRefreshIntervalMinutes: 60,
        checkPricesOnStartup: true,
        pricesRefreshIntervalMinutes: 60,
        notifyOnNewModelsOnly: false,
        notifyOnPriceChanges: true,
        notifyOnEveryCheck: false,
        showDiscount: true,
      },
      notify: notifyMock,
    })

    // 1st sync (initialization)
    mockTransport.listModels.mockResolvedValueOnce([
      {
        id: 'gpt-4o',
        contextWindow: 128000,
        source: 'backend',
        pricing: { input: 5, output: 15, discount: 0 },
      } as ModelConfig,
    ])
    await syncManager.syncAll()
    expect(notifyMock).not.toHaveBeenCalled()

    // 2nd sync (price update)
    mockTransport.listModels.mockResolvedValueOnce([
      {
        id: 'gpt-4o',
        contextWindow: 128000,
        source: 'backend',
        pricing: { input: 2.5, output: 10, discount: 20 },
      } as ModelConfig,
    ])
    await syncManager.syncAll()

    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock).toHaveBeenCalledWith({
      title: 'CheaperInference Pricing Updated',
      body: 'gpt-4o:\n• In: $5.000 → $2.500\n• Out: $15.000 → $10.000\n• Promo: 0% → 20%',
    })
  })
})
