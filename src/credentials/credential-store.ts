export interface ProviderCredentialStore {
  create(credential: unknown): Promise<string>
  get(reference: string): Promise<unknown | undefined>
  set(reference: string, credential: unknown): Promise<void>
  delete(reference: string): Promise<void>
  listReferences(): Promise<string[]>
}
