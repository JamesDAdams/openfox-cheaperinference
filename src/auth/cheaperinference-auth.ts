import type {
  ProviderAuthAdapter,
  ProviderAuthStatus,
  ProviderAccessContext,
  ProviderLoginChallenge,
  ProviderRequestContext,
} from 'openfox/provider'
import type { ProviderCredentialStore } from '../credentials/credential-store.js'

export interface CheaperInferenceCredential {
  apiKey: string
}

export class CheaperInferenceAuthAdapter implements ProviderAuthAdapter {
  readonly id = 'cheaperinference-auth'

  constructor(private readonly credentials: ProviderCredentialStore) {}

  async beginLogin(_context: { providerId: string }): Promise<{
    challenge: ProviderLoginChallenge
    completion: Promise<{ credentialRef: string }>
  }> {
    const directUrl = 'https://platform.cheaperinference.com/keys'
    const instructions =
      'Create or copy your API key from CheaperInference Dashboard (https://platform.cheaperinference.com/keys) and paste it into OpenFox.'

    const challenge: ProviderLoginChallenge = {
      verificationUrl: directUrl,
      directUrl,
      instructions,
      mode: 'browser',
    }

    const completion = Promise.reject(
      new Error('Please configure the API key in the provider settings.'),
    )

    return { challenge, completion }
  }

  async getStatus(context: { providerId: string; credentialRef?: string }): Promise<ProviderAuthStatus> {
    if (!context.credentialRef) return { state: 'disconnected' }
    const cred = (await this.credentials.get(context.credentialRef)) as CheaperInferenceCredential | undefined
    if (!cred?.apiKey) return { state: 'disconnected' }
    return { state: 'connected' }
  }

  async getAccessContext(credentialRef: string): Promise<ProviderAccessContext> {
    const cred = (await this.credentials.get(credentialRef)) as CheaperInferenceCredential | undefined
    return {
      accessToken: cred?.apiKey,
      headers: cred?.apiKey ? { Authorization: `Bearer ${cred.apiKey}` } : {},
    }
  }

  async logout(credentialRef: string): Promise<void> {
    await this.credentials.delete(credentialRef)
  }

  async revoke(context: { providerId: string; credentialRef?: string }): Promise<void> {
    if (context.credentialRef) {
      await this.credentials.delete(context.credentialRef)
    }
  }

  async resolveApiKey(context: ProviderRequestContext | ProviderAccessContext): Promise<string | undefined> {
    const credRef = (context as any).provider?.credentialRef ?? (context as any).credentialRef
    if (credRef) {
      const cred = (await this.credentials.get(credRef)) as CheaperInferenceCredential | undefined
      if (cred?.apiKey) return cred.apiKey
    }

    const directKey =
      (context as any).apiKey ??
      (context as any).provider?.apiKey ??
      (context as any).auth?.accessToken
    if (directKey) return directKey

    if (process.env.CHEAPERINFERENCE_API_KEY) {
      return process.env.CHEAPERINFERENCE_API_KEY
    }

    return undefined
  }

  async saveApiKey(apiKey: string): Promise<string> {
    return this.credentials.create({ apiKey })
  }
}
