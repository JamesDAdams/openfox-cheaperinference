import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderPluginRegistry } from 'openfox/provider'
import { register } from './index.js'
import { CheaperInferenceAuthAdapter } from './auth/cheaperinference-auth.js'
import { CheaperInferenceTransportAdapter } from './transport/cheaperinference.js'
import { MemoryProviderCredentialStore } from './credentials/credential-store.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('openfox-cheaperinference plugin registration', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openfox-cheaperinference-test-'))
    vi.resetAllMocks()
    delete process.env.CHEAPERINFERENCE_API_KEY
    delete (globalThis as any)[Symbol.for('openfox.pendingQuotaProviders')]
    delete (globalThis as any)[Symbol.for('openfox.quotaManager')]
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('registers auth, transport, preset, settings, and quota through public API', async () => {
    const registry: ProviderPluginRegistry = {
      runtime: { mode: 'production', configDirectory: tempDir },
      registerAuth: vi.fn(),
      registerTransport: vi.fn(),
      registerPreset: vi.fn(),
    }
    await register(registry)
    expect(registry.registerAuth).toHaveBeenCalledWith(expect.objectContaining({ id: 'cheaperinference-auth' }))
    expect(registry.registerTransport).toHaveBeenCalledWith(expect.objectContaining({ id: 'cheaperinference-transport' }))
    expect(registry.registerPreset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'cheaperinference',
        requiresAuth: false,
        transportAdapter: 'cheaperinference-transport',
      }),
    )
  })

  it('registers quota provider when registerQuotaProvider is available', async () => {
    const registry: ProviderPluginRegistry = {
      runtime: { mode: 'production', configDirectory: tempDir },
      registerAuth: vi.fn(),
      registerTransport: vi.fn(),
      registerPreset: vi.fn(),
      registerQuotaProvider: vi.fn(),
    }
    await register(registry)
    expect(registry.registerQuotaProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'cheaperinference' }))
  })

  it('does not throw when registerQuotaProvider is absent', async () => {
    const registry: ProviderPluginRegistry = {
      runtime: { mode: 'production', configDirectory: tempDir },
      registerAuth: vi.fn(),
      registerTransport: vi.fn(),
      registerPreset: vi.fn(),
    }
    await expect(register(registry)).resolves.toBeUndefined()
  })

  it('registers RPCs, quota tool, hook, and settings when available', async () => {
    const rpcs: Record<string, Function> = {}
    let registeredTool: any
    let registeredHook: any
    let registeredSettings: any

    const registry: any = {
      runtime: { mode: 'production', configDirectory: tempDir },
      registerAuth: vi.fn(),
      registerTransport: vi.fn(),
      registerPreset: vi.fn(),
      registerQuotaProvider: vi.fn(),
      registerRpc: vi.fn((method, handler) => {
        rpcs[method] = handler
      }),
      registerTool: vi.fn((tool) => {
        registeredTool = tool
      }),
      registerHook: vi.fn((event, handler) => {
        if (event === 'turn.completed') registeredHook = handler
      }),
      registerSettings: vi.fn((settings) => {
        registeredSettings = settings
      }),
      notify: vi.fn(),
    }

    await register(registry)

    expect(registry.registerRpc).toHaveBeenCalledWith('cheaperinference.getQuota', expect.any(Function))
    expect(registry.registerRpc).toHaveBeenCalledWith('cheaperinference.syncQuota', expect.any(Function))
    expect(registry.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'get_cheaperinference_quota' }))
    expect(registry.registerHook).toHaveBeenCalledWith('turn.completed', expect.any(Function))
    expect(registry.registerSettings).toHaveBeenCalled()

    // Test getQuota RPC without filter
    const quotaResult = await rpcs['cheaperinference.getQuota']?.({})
    expect(quotaResult?.sources).toBeDefined()

    // Test syncQuota RPC
    const syncResult = await rpcs['cheaperinference.syncQuota']?.()
    expect(syncResult?.success).toBe(true)

    // Test tool execution
    const toolExec = await registeredTool.execute({}, {})
    expect(toolExec.success).toBe(true)
    expect(toolExec.output).toContain('sources')

    // Test hook execution
    await expect(registeredHook?.()).resolves.toBeUndefined()

    // Test settings getSettings, saveSettings, executeAction
    expect(registeredSettings).toBeDefined()
    const currentSettings = await registeredSettings.getSettings()
    expect(currentSettings).toBeDefined()
    expect(currentSettings.showDiscount).toBe(true)

    await registeredSettings.saveSettings({ showDiscount: false })
    const updatedSettings = await registeredSettings.getSettings()
    expect(updatedSettings.showDiscount).toBe(false)
  })

  it('filters account in RPC and tool when providerId is provided', async () => {
    // Create config.json with a cheaperinference provider
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        providers: [
          {
            id: 'cheaper-1',
            name: 'Cheaper Inference 1',
            preset: 'cheaperinference',
            apiKey: 'sk-test-key-1',
          },
        ],
      }),
    )

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        total_credits: 1000,
        credits_remaining: 800,
      }),
    })

    const rpcs: Record<string, Function> = {}
    let registeredTool: any

    const registry: any = {
      runtime: { mode: 'production', configDirectory: tempDir },
      registerAuth: vi.fn(),
      registerTransport: vi.fn(),
      registerPreset: vi.fn(),
      registerRpc: vi.fn((method, handler) => {
        rpcs[method] = handler
      }),
      registerTool: vi.fn((tool) => {
        registeredTool = tool
      }),
    }

    await register(registry)

    // Test RPC with providerId
    const res = await rpcs['cheaperinference.getQuota']?.({ providerId: 'cheaper-1' })
    expect(res.source).toBeDefined()
    expect(res.source.id).toBe('cheaper-1')
    expect(res.source.metrics).toHaveLength(1)

    // Test tool with providerId
    const toolRes = await registeredTool.execute({ providerId: 'cheaper-1' }, {})
    expect(toolRes.success).toBe(true)
    expect(toolRes.output).toContain('cheaper-1')
    expect(toolRes.output).toContain('Credits Balance')
  })
})

describe('CheaperInferenceAuthAdapter', () => {
  let store: MemoryProviderCredentialStore
  let auth: CheaperInferenceAuthAdapter

  beforeEach(() => {
    store = new MemoryProviderCredentialStore()
    auth = new CheaperInferenceAuthAdapter(store)
    delete process.env.CHEAPERINFERENCE_API_KEY
  })

  it('returns external verification challenge on beginLogin', async () => {
    const { challenge, completion } = await auth.beginLogin({ providerId: 'cheaper-test' })
    expect(challenge.mode).toBe('external')
    expect(challenge.verificationUrl).toBe('https://platform.cheaperinference.com/keys')
    const res = await completion
    expect(res.credentialRef).toBe('')
  })

  it('creates credential when apiKey is provided in beginLogin', async () => {
    const { completion } = await auth.beginLogin({
      providerId: 'cheaper-test',
      apiKey: 'sk-direct-login-key',
    })
    const { credentialRef } = await completion
    expect(credentialRef).toBeTruthy()
    const stored = (await store.get(credentialRef)) as any
    expect(stored?.apiKey).toBe('sk-direct-login-key')
  })

  it('returns proper status when disconnected vs connected', async () => {
    const disconnected = await auth.getStatus({ providerId: 'cheaper-test' })
    expect(disconnected.state).toBe('disconnected')

    const ref = await auth.saveApiKey('sk-saved-key')
    const connected = await auth.getStatus({ providerId: 'cheaper-test', credentialRef: ref })
    expect(connected.state).toBe('connected')
  })

  it('resolves API key from context, credentials, or environment variable', async () => {
    // 1. From direct apiKey
    const key1 = await auth.resolveApiKey({ apiKey: 'sk-ctx-key' } as any)
    expect(key1).toBe('sk-ctx-key')

    // 2. From credentialRef
    const ref = await auth.saveApiKey('sk-ref-key')
    const key2 = await auth.resolveApiKey({ credentialRef: ref } as any)
    expect(key2).toBe('sk-ref-key')

    // 3. From environment variable
    process.env.CHEAPERINFERENCE_API_KEY = 'sk-env-key'
    const key3 = await auth.resolveApiKey({} as any)
    expect(key3).toBe('sk-env-key')
  })

  it('returns access context headers with Bearer token', async () => {
    const ref = await auth.saveApiKey('sk-auth-header-key')
    const ctx = await auth.getAccessContext(ref)
    expect(ctx.accessToken).toBe('sk-auth-header-key')
    expect(ctx.headers).toEqual({ Authorization: 'Bearer sk-auth-header-key' })
  })

  it('deletes credentials on logout and revoke', async () => {
    const ref = await auth.saveApiKey('sk-to-delete')
    expect(await store.get(ref)).toBeDefined()
    await auth.logout(ref)
    expect(await store.get(ref)).toBeUndefined()

    const ref2 = await auth.saveApiKey('sk-to-revoke')
    await auth.revoke({ providerId: 'cheaper-test', credentialRef: ref2 })
    expect(await store.get(ref2)).toBeUndefined()
  })
})

describe('CheaperInferenceTransportAdapter integration', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('calls chat completion with auth header and correct payload', async () => {
    const store = new MemoryProviderCredentialStore()
    const auth = new CheaperInferenceAuthAdapter(store)
    const ref = await auth.saveApiKey('sk-transport-key')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'Hello from Cheaper Inference!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    })

    const transport = new CheaperInferenceTransportAdapter(auth, undefined, {
      fetcher: mockFetch as any,
    })

    const response = await transport.complete(
      {
        messages: [{ role: 'user', content: 'Hi' }],
      } as any,
      {
        credentialRef: ref,
        model: 'gpt-4o',
        provider: { id: 'p1' },
      } as any,
    )

    expect(response.content).toBe('Hello from Cheaper Inference!')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.cheaperinference.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-transport-key',
        }),
      }),
    )
  })
})
