export interface CheaperInferencePluginSettings {
  /** API key for CheaperInference */
  apiKey?: string
  /** Check models on startup */
  checkModelsOnStartup: boolean
  /** Interval in minutes between model updates */
  modelsRefreshIntervalMinutes: number
  /** Check pricing on startup */
  checkPricesOnStartup: boolean
  /** Interval in minutes between pricing updates */
  pricesRefreshIntervalMinutes: number
  /** Notify only when new models are discovered or removed */
  notifyOnNewModelsOnly: boolean
  /** Notify when model pricing changes */
  notifyOnPriceChanges: boolean
  /** Notify on every batch check */
  notifyOnEveryCheck: boolean
  /** Whether to surface and calculate discounts for models (default: true) */
  showDiscount: boolean
}

export interface ModelPricing {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  discount?: number | string
}

export interface CheaperInferenceModelApiItem {
  id: string
  context_length?: number | null
  max_output_tokens?: number | null
  model_type?: string
  input_per_million?: string | null
  output_per_million?: string | null
  cache_read_per_million?: string | null
  cache_write_per_million?: string | null
  reference_input_per_million?: string | null
  reference_output_per_million?: string | null
  reference_cache_read_per_million?: string | null
  reference_cache_write_per_million?: string | null
  discount_percent?: string | null
  provider_name?: string
  supports_vision?: boolean
  supports_video?: boolean
  supports_reasoning?: boolean
  supports_streaming?: boolean
}
