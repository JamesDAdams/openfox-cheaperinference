import { describe, it, expect, vi } from 'vitest'
import { CheaperInferenceTransportAdapter } from './transport/cheaperinference.js'
import { PluginSettingsStore } from './settings.js'
import type { ModelPricing } from './types.js'
import type { ModelConfig } from 'openfox/provider'

type ModelWithPricing = ModelConfig & { pricing?: ModelPricing }

describe('CheaperInferenceTransportAdapter', () => {
  const dummyAuth = {
    resolveApiKey: vi.fn().mockResolvedValue('test-api-key'),
  } as any

  const dummyCatalogResponse = {
    models: [
      {
        id: 'glm-5.3-flash',
        context_length: 1048576,
        model_type: 'text',
        input_per_million: '0.060426',
        output_per_million: '0.201421',
        cache_read_per_million: '0.012085',
        cache_write_per_million: '0.060426',
        discount_percent: '59.72',
        supports_vision: true,
      },
      {
        id: 'nano-banana',
        model_type: 'image',
      },
      {
        id: 'gpt-4o',
        context_length: 128000,
        model_type: 'text',
        input_per_million: '2.500000',
        output_per_million: '10.000000',
      },
    ],
  }

  it('lists models with dynamic pricing and discount when showDiscount is true', async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => dummyCatalogResponse,
    })

    const settingsStore = {
      getCached: () => ({ showDiscount: true }),
    } as unknown as PluginSettingsStore

    const transport = new CheaperInferenceTransportAdapter(dummyAuth, settingsStore, {
      fetcher: mockFetcher as any,
    })

    const models = (await transport.listModels({ provider: { id: 'p1' } } as any)) as ModelWithPricing[]
    expect(models).toHaveLength(2) // image model filtered out

    const glm = models.find((m) => m.id === 'glm-5.3-flash')
    expect(glm).toBeDefined()
    expect(glm?.contextWindow).toBe(1048576)
    expect(glm?.supportsVision).toBe(true)
    expect(glm?.pricing).toEqual({
      input: 0.060426,
      output: 0.201421,
      cacheRead: 0.012085,
      cacheWrite: 0.060426,
      discount: 59.72,
    })

    const gpt = models.find((m) => m.id === 'gpt-4o')
    expect(gpt?.pricing).toEqual({
      input: 2.5,
      output: 10,
    })
  })

  it('omits discount field when showDiscount is false', async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => dummyCatalogResponse,
    })

    const settingsStore = {
      getCached: () => ({ showDiscount: false }),
    } as unknown as PluginSettingsStore

    const transport = new CheaperInferenceTransportAdapter(dummyAuth, settingsStore, {
      fetcher: mockFetcher as any,
    })

    const models = (await transport.listModels({ provider: { id: 'p1' } } as any)) as ModelWithPricing[]
    const glm = models.find((m) => m.id === 'glm-5.3-flash')
    expect(glm?.pricing).toEqual({
      input: 0.060426,
      output: 0.201421,
      cacheRead: 0.012085,
      cacheWrite: 0.060426,
    })
    expect(glm?.pricing?.discount).toBeUndefined()
  })

  it('performs complete request forwarding Authorization header', async () => {
    const mockResponse = {
      choices: [
        {
          message: { content: 'Hello world', tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }

    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    })

    const transport = new CheaperInferenceTransportAdapter(dummyAuth, undefined, {
      fetcher: mockFetcher as any,
    })

    const result = await transport.complete(
      {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Hi' }] as any,
      } as any,
      { provider: { id: 'p1', url: 'https://api.cheaperinference.com/v1' } } as any,
    )

    expect(result.content).toBe('Hello world')
    expect(mockFetcher).toHaveBeenCalledWith(
      'https://api.cheaperinference.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
        }),
      }),
    )
  })
})
