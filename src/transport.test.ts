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
        reference_input_per_million: '0.150000',
        reference_output_per_million: '0.500000',
        reference_cache_read_per_million: '0.030000',
        reference_cache_write_per_million: '0.150000',
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

  it('lists models with reference / reconstructed original pricing and discount when showDiscount is true', async () => {
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
      input: 0.15,
      output: 0.5,
      cacheRead: 0.03,
      cacheWrite: 0.15,
      discount: 59.72,
    })

    const gpt = models.find((m) => m.id === 'gpt-4o')
    expect(gpt?.pricing).toEqual({
      input: 2.5,
      output: 10,
    })
  })

  it('reconstructs original pricing from discount percentage when reference prices are absent', async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            id: 'deepseek-v4-flash',
            context_length: 1000000,
            model_type: 'text',
            input_per_million: '0.05',
            output_per_million: '0.10',
            discount_percent: '50',
          },
        ],
      }),
    })

    const settingsStore = {
      getCached: () => ({ showDiscount: true }),
    } as unknown as PluginSettingsStore

    const transport = new CheaperInferenceTransportAdapter(dummyAuth, settingsStore, {
      fetcher: mockFetcher as any,
    })

    const models = (await transport.listModels({ provider: { id: 'p1' } } as any)) as ModelWithPricing[]
    const deepseek = models.find((m) => m.id === 'deepseek-v4-flash')
    expect(deepseek?.pricing).toEqual({
      input: 0.1,
      output: 0.2,
      discount: 50,
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
      input: 0.061,
      output: 0.202,
      cacheRead: 0.013,
      cacheWrite: 0.061,
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
