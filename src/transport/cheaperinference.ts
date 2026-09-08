import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ProviderTransportAdapter,
  ProviderRequestContext,
  ModelConfig,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamEvent,
  ToolCall,
} from 'openfox/provider'
import type { CheaperInferenceAuthAdapter } from '../auth/cheaperinference-auth.js'
import type { PluginSettingsStore } from '../settings.js'
import type { CheaperInferenceModelApiItem, ModelPricing } from '../types.js'

const CHEAPERINFERENCE_PUBLIC_API = 'https://api.cheaperinference.com/public/models'
const CHEAPERINFERENCE_DEFAULT_BASE_URL = 'https://api.cheaperinference.com/v1'

export interface CheaperInferenceTransportOptions {
  publicModelsUrl?: string
  fetcher?: typeof fetch
  configDirectory?: string
}

function roundUpTo3Decimals(val: number | undefined): number | undefined {
  if (val === undefined || isNaN(val)) return undefined
  if (val === 0) return 0
  const scaled = Math.round(val * 1e8) / 1e5
  return Math.ceil(scaled) / 1000
}

export class CheaperInferenceTransportAdapter implements ProviderTransportAdapter {
  readonly id = 'cheaperinference-transport'

  constructor(
    private readonly auth: CheaperInferenceAuthAdapter,
    private readonly settingsStore?: PluginSettingsStore,
    private readonly options: CheaperInferenceTransportOptions = {},
  ) {}

  async listModels(_context: ProviderRequestContext): Promise<ModelConfig[]> {
    const fetcher = this.options.fetcher ?? fetch
    const settings = this.settingsStore?.getCached()
    const showDiscount = settings?.showDiscount ?? true

    try {
      const publicUrl = this.options.publicModelsUrl ?? CHEAPERINFERENCE_PUBLIC_API
      const response = await fetcher(publicUrl)
      if (!response.ok) {
        throw new Error(`CheaperInference catalog HTTP error (${response.status})`)
      }
      const data = (await response.json()) as { models?: CheaperInferenceModelApiItem[] }
      const models = data.models ?? []

      return models
        .filter((m) => m.model_type !== 'image' && m.model_type !== 'video')
        .map((m) => {
          const pricing: ModelPricing = {}

          if (showDiscount) {
            const discNum = m.discount_percent ? parseFloat(m.discount_percent) : 0
            const hasDiscount = !isNaN(discNum) && discNum > 0 && discNum < 100
            const factor = hasDiscount ? 1 - discNum / 100 : 1

            if (hasDiscount) {
              pricing.discount = discNum
            } else if (m.discount_percent) {
              pricing.discount = m.discount_percent
            }

            if (m.reference_input_per_million) {
              pricing.input = roundUpTo3Decimals(parseFloat(m.reference_input_per_million))
            } else if (m.input_per_million) {
              const discounted = parseFloat(m.input_per_million)
              pricing.input = roundUpTo3Decimals(hasDiscount ? discounted / factor : discounted)
            }

            if (m.reference_output_per_million) {
              pricing.output = roundUpTo3Decimals(parseFloat(m.reference_output_per_million))
            } else if (m.output_per_million) {
              const discounted = parseFloat(m.output_per_million)
              pricing.output = roundUpTo3Decimals(hasDiscount ? discounted / factor : discounted)
            }

            if (m.reference_cache_read_per_million) {
              pricing.cacheRead = roundUpTo3Decimals(parseFloat(m.reference_cache_read_per_million))
            } else if (m.cache_read_per_million) {
              const discounted = parseFloat(m.cache_read_per_million)
              pricing.cacheRead = roundUpTo3Decimals(hasDiscount ? discounted / factor : discounted)
            }

            if (m.reference_cache_write_per_million) {
              pricing.cacheWrite = roundUpTo3Decimals(parseFloat(m.reference_cache_write_per_million))
            } else if (m.cache_write_per_million) {
              const discounted = parseFloat(m.cache_write_per_million)
              pricing.cacheWrite = roundUpTo3Decimals(hasDiscount ? discounted / factor : discounted)
            }
          } else {
            if (m.input_per_million) pricing.input = roundUpTo3Decimals(parseFloat(m.input_per_million))
            if (m.output_per_million) pricing.output = roundUpTo3Decimals(parseFloat(m.output_per_million))
            if (m.cache_read_per_million) pricing.cacheRead = roundUpTo3Decimals(parseFloat(m.cache_read_per_million))
            if (m.cache_write_per_million) pricing.cacheWrite = roundUpTo3Decimals(parseFloat(m.cache_write_per_million))
          }

          const hasPricing = Object.keys(pricing).length > 0

          return {
            id: m.id,
            contextWindow: m.context_length ?? 128000,
            source: 'backend' as const,
            supportsVision: m.supports_vision ?? false,
            ...(hasPricing ? { pricing } : {}),
          } as ModelConfig
        })
    } catch {
      return []
    }
  }

  async complete(
    request: LLMCompletionRequest,
    context: ProviderRequestContext,
  ): Promise<LLMCompletionResponse> {
    const fetcher = this.options.fetcher ?? fetch
    const apiKey = await this.resolveKey(context)
    const baseUrl = (context.requestBody?.['baseUrl'] as string | undefined) || CHEAPERINFERENCE_DEFAULT_BASE_URL

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    }

    const body = {
      model: context.model || context.catalogModel,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      tools: request.tools,
      tool_choice: request.toolChoice,
      stream: false,
    }

    const response = await fetcher(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`CheaperInference API error (${response.status}): ${errorText}`)
    }

    const data = (await response.json()) as any
    const choice = data.choices?.[0]

    return {
      id: data.id || 'chatcmpl-' + crypto.randomUUID(),
      content: choice?.message?.content ?? '',
      toolCalls: choice?.message?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      })),
      finishReason: choice?.finish_reason || 'stop',
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    }
  }

  async *stream(
    request: LLMCompletionRequest,
    context: ProviderRequestContext,
  ): AsyncIterable<LLMStreamEvent> {
    const fetcher = this.options.fetcher ?? fetch
    const apiKey = await this.resolveKey(context)
    const baseUrl = (context.requestBody?.['baseUrl'] as string | undefined) || CHEAPERINFERENCE_DEFAULT_BASE_URL

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    }

    const body = {
      model: context.model || context.catalogModel,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      tools: request.tools,
      tool_choice: request.toolChoice,
      stream: true,
    }

    const response = await fetcher(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`CheaperInference API streaming error (${response.status}): ${errorText}`)
    }

    if (!response.body) {
      throw new Error('No response body from CheaperInference streaming endpoint')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''
    let fullThinking = ''
    let finishReason: LLMCompletionResponse['finishReason'] = 'stop'
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    let responseId = 'chatcmpl-' + crypto.randomUUID()
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue
          if (trimmed === 'data: [DONE]') {
            continue
          }
          if (trimmed.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trimmed.slice(6))
              if (parsed.id) responseId = parsed.id
              if (parsed.usage) {
                usage = {
                  promptTokens: parsed.usage.prompt_tokens ?? 0,
                  completionTokens: parsed.usage.completion_tokens ?? 0,
                  totalTokens: parsed.usage.total_tokens ?? 0,
                }
              }
              const choice = parsed.choices?.[0]
              if (choice?.finish_reason) {
                finishReason = choice.finish_reason
              }
              const delta = choice?.delta
              if (delta) {
                const thinking = delta.reasoning_content || delta.reasoning || delta.thinking
                if (thinking) {
                  fullThinking += thinking
                  yield { type: 'thinking_delta', content: thinking }
                }
                if (delta.content) {
                  fullContent += delta.content
                  yield { type: 'text_delta', content: delta.content }
                }
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const existing = toolCalls.get(tc.index)
                    if (!existing) {
                      toolCalls.set(tc.index, {
                        id: tc.id ?? '',
                        name: tc.function?.name ?? '',
                        arguments: tc.function?.arguments ?? '',
                      })
                    } else {
                      if (tc.id) existing.id = tc.id
                      if (tc.function?.name) existing.name += tc.function.name
                      if (tc.function?.arguments) existing.arguments += tc.function.arguments
                    }
                    yield {
                      type: 'tool_call_delta',
                      index: tc.index,
                      ...(tc.id ? { id: tc.id } : {}),
                      ...(tc.function?.name ? { name: tc.function.name } : {}),
                      ...(tc.function?.arguments ? { arguments: tc.function.arguments } : {}),
                    }
                  }
                }
              }
            } catch {
              // Ignore malformed JSON chunk
            }
          }
        }
      }

      const parsedToolCalls: ToolCall[] = []
      for (const [, tc] of toolCalls) {
        try {
          parsedToolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.arguments) as Record<string, unknown>,
          })
        } catch {
          parsedToolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: {},
          })
        }
      }

      yield {
        type: 'done',
        response: {
          id: responseId,
          content: fullContent,
          thinkingContent: fullThinking || undefined,
          toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
          finishReason,
          usage,
        },
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async resolveKey(context: ProviderRequestContext): Promise<string | undefined> {
    if (context.auth?.accessToken) return context.auth.accessToken
    const fromAuth = await this.auth.resolveApiKey(context)
    if (fromAuth) return fromAuth
    const settings = this.settingsStore?.getCached()
    if (settings?.apiKey) return settings.apiKey

    if (this.options.configDirectory) {
      try {
        const configPath = join(this.options.configDirectory, 'config.json')
        const raw = await readFile(configPath, 'utf8')
        const data = JSON.parse(raw) as {
          providers?: Array<{
            id: string
            apiKey?: string
            transportAdapter?: string
            url?: string
          }>
        }
        const providerId = context.providerId
        const provider = data.providers?.find((p) =>
          providerId
            ? p.id === providerId
            : p.transportAdapter === 'cheaperinference-transport' ||
              p.url?.includes('cheaperinference'),
        )
        if (provider?.apiKey) {
          return provider.apiKey
        }
      } catch {
        // config.json not readable or not present
      }
    }

    if (process.env.CHEAPERINFERENCE_API_KEY) return process.env.CHEAPERINFERENCE_API_KEY
    return undefined
  }
}
