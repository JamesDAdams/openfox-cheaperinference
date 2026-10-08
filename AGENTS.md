# AGENTS.md — openfox-cheaperinference

Paths relative to `openfox-plugins/openfox-cheaperinference/`.

## Purpose

OpenFox LLM provider for CheaperInference: access discount AI models through a unified API with dynamic pricing, discount badges, and automatic price synchronization.

## Stack

- TypeScript, ESM, tsup, vitest 4.x
- peerDep: `openfox >=2.0.56 <3`

## Commands

```bash
npm run build      # tsup
npm test           # vitest run --passWithNoTests --config vitest.config.ts
npm run typecheck  # tsc --noEmit
```

## Project Map

```
src/
├── index.ts                     # Entry point (register, preset provider)
├── types.ts                     # TypeScript types
├── settings.ts                  # Settings management
├── sync-manager.ts              # Background price synchronization
├── auth/
│   └── cheaperinference-auth.ts  # Authentication
├── credentials/
│   ├── credential-store.ts      # Credential store interface
│   └── file-credential-store.ts # File-based implementation
├── quota/
│   ├── cheaperinference.ts      # Quota logic
│   └── contract.ts              # Quota contract (shared)
└── transport/
    └── cheaperinference.ts      # HTTP transport to CheaperInference
```

## Where to Look What

- **Modify HTTP transport** → `src/transport/cheaperinference.ts`
- **Modify authentication** → `src/auth/cheaperinference-auth.ts`
- **Modify quota handling** → `src/quota/cheaperinference.ts`
- **Add a setting** → `src/settings.ts`
- **Modify price synchronization** → `src/sync-manager.ts`

## Conventions

- `apiVersion: 2`, capabilities: `tools`, `hooks`, `rpc`, `presets`, `settings`
- ESM build only via tsup
- `openfox` is externalized (provided by host)
- `.test.ts` files are co-located in `src/`

## Cross-Project Dependencies

**Consumes**: `openfox/provider` (ProviderPluginRegistry, ProviderPreset), `openfox-quota` contract via `src/quota/contract.ts`.

**Consumed by**: OpenFox (loaded as provider plugin).

**Touchpoints**:

- `src/index.ts` (register, provider preset)
- `src/quota/contract.ts` (quota contract)
- `src/transport/cheaperinference.ts` (HTTP transport)

## Known Gotchas

- `dist/index.js` is the entry point loaded by OpenFox, not `src/`.
- The quota contract (`src/quota/contract.ts`) is shared across provider plugins. Do not modify without verifying compatibility.
- `credentials.json` and `credentials.key` must never be committed.

## Do Not Read / Do Not Touch

- `node_modules/`, `dist/`, `.git/`
- `credentials.json`, `credentials.key`

## Further Reading

- [README.md](README.md) — overview

---

> After any change affecting structure, a command, a convention, an inter-project contract, or a primary flow, update this file in the same commit. If any information here is inaccurate, fix it.
