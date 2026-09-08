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
    expect(body).toBe('openai/gpt-4o: in $5->$2.5, out $15->$10')
  })

  it('formats discount / promo changes', () => {
    const body = formatPriceDiffBody([
      {
        modelId: 'anthropic/claude-3-5-sonnet',
        oldPricing: { input: 3, output: 15, discount: 10 },
        newPricing: { input: 3, output: 15, discount: 20 },
      },
    ])
    expect(body).toBe('anthropic/claude-3-5-sonnet: promo 10%->20%')
  })

  it('formats price and promo changes together', () => {
    const body = formatPriceDiffBody([
      {
        modelId: 'deepseek/deepseek-r1',
        oldPricing: { input: 0.55, output: 2.19 },
        newPricing: { input: 0.4, output: 2.0, discount: 15 },
      },
    ])
    expect(body).toBe('deepseek/deepseek-r1: in $0.55->$0.4, out $2.19->$2, promo none->15%')
  })

  it('formats multiple models with truncation if more than limit', () => {
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
    expect(body).toBe('model-1: in $1->$2; model-2: promo 5%->10% (+2 others)')
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
      body: 'gpt-4o: in $5->$2.5, out $15->$10, promo 0%->20%',
    })
  })
})
