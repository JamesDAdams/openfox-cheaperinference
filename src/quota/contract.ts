import type { ProviderPluginRegistry } from 'openfox/provider'

export type LocalizedString = { en: string; fr: string }
export type PluginRegistry = ProviderPluginRegistry

export type PluginBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export type PluginActivation =
  | { kind: 'rpc'; method: string; params?: Record<string, unknown> }
  | { kind: 'openPanel'; panelId: string }
  | { kind: 'openUrl'; url: string }

export type DeclarativeNode =
  | { type: 'text'; text: LocalizedString; muted?: boolean; className?: string }
  | { type: 'keyValue'; items: { key: LocalizedString; value: string }[] }
  | { type: 'table'; columns: LocalizedString[]; rows: string[][] }
  | { type: 'progress'; label: LocalizedString; value: number; max: number; tone?: PluginBadgeTone }
  | { type: 'badge'; label: LocalizedString; tone?: PluginBadgeTone }
  | {
      type: 'button'
      label: LocalizedString
      variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'pill'
      icon?: string
      onActivate: PluginActivation
    }
  | { type: 'divider' }
  | {
      type: 'stack'
      direction?: 'row' | 'column'
      gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg'
      align?: 'start' | 'center' | 'end' | 'stretch'
      justify?: 'start' | 'center' | 'end' | 'between'
      className?: string
      children: DeclarativeNode[]
    }
  | {
      type: 'card'
      title?: LocalizedString
      subtitle?: LocalizedString
      tone?: PluginBadgeTone
      children: DeclarativeNode[]
    }
  | {
      type: 'callout'
      tone?: PluginBadgeTone
      title?: LocalizedString
      text: LocalizedString
      icon?: string
    }
  | {
      type: 'icon'
      icon: string
      tone?: PluginBadgeTone
      className?: string
    }

export type MetricDisplayMode = 'gauge' | 'value'

export type QuotaMetric =
  | {
      kind: 'windowed'
      label: string
      used: number
      limit: number
      window: 'hour' | 'day' | 'week' | 'month'
      model?: string
      resetsAt?: string
      unit?: string
      subtitle?: LocalizedString
      icon?: string
      displayMode?: MetricDisplayMode
      formattedValue?: string | LocalizedString
    }
  | {
      kind: 'token-balance'
      label: string
      total: number
      remaining: number
      model?: string
      unit?: string
      currency?: string
      subtitle?: LocalizedString
      icon?: string
      displayMode?: MetricDisplayMode
      formattedValue?: string | LocalizedString
    }
  | {
      kind: 'currency'
      label: string
      amount: number
      currency?: string
      subtitle?: LocalizedString
      tone?: PluginBadgeTone
      model?: string
      icon?: string
      displayMode?: MetricDisplayMode
      formattedValue?: string | LocalizedString
    }

export interface QuotaSource {
  id: string
  name: string
  description?: string
  metrics: QuotaMetric[]
}

export interface QuotaProviderAssignment {
  sourceId: string
  providerId: string
  providerName?: string
  selectedModels?: string[]
}

export interface QuotaProvider {
  readonly id: string
  readonly name: string
  getQuota(): Promise<QuotaSource> | QuotaSource
}

export interface CustomQuotaSection {
  readonly id: string
  readonly title?: LocalizedString
  readonly order?: number
  render(context?: { locale?: string }): Promise<DeclarativeNode[] | DeclarativeNode> | DeclarativeNode[] | DeclarativeNode
  getState?(): Promise<Record<string, unknown>> | Record<string, unknown>
}

export interface PluginContext {
  readonly id?: string
  readonly version?: string
  readonly runtime?: { mode: 'production' | 'development'; configDirectory: string }
  readonly logger?: {
    debug(message: string, context?: Record<string, unknown>): void
    info(message: string, context?: Record<string, unknown>): void
    warn(message: string, context?: Record<string, unknown>): void
    error(message: string, context?: Record<string, unknown>): void
  }
  readonly storage?: {
    get(key: string): unknown
    set(key: string, value: unknown): void
  }
  settings?(scope?: 'global' | 'project', projectId?: string): Record<string, unknown>
  notify?(request: {
    title: LocalizedString
    body?: LocalizedString
    level?: 'info' | 'success' | 'warning' | 'error'
    actions?: { label: LocalizedString; onActivate: any }[]
  }): void
  publish?(panelId: string | undefined, key: string, value: unknown): void
}

declare module 'openfox/provider' {
  interface ProviderPluginRegistry {
    context?: PluginContext
    registerQuotaProvider?(provider: QuotaProvider): void
    registerCustomQuotaSection?(section: CustomQuotaSection): void
    registerHook?(event: string, handler: (payload: any) => void | Promise<void>): void
    registerRpc?(
      method: string,
      handler: (params: Record<string, unknown>, context: Record<string, unknown>) => unknown | Promise<unknown>,
    ): void
    registerTool?(tool: {
      name: string
      description: string
      parameters: Record<string, unknown>
      execute(args: Record<string, unknown>, context: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }>
    }): void
  }
}
