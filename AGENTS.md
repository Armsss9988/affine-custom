# AFFiNE Monorepo (@affine/monorepo v0.26.3)

Privacy-first knowledge management: notes+whiteboarding (Notion+Miro). BlockSuite editor, AI Copilot.

## Tech Stack

| Layer | Technologies |
|---|---|
| **Monorepo** | Yarn 4 (PnP), TypeScript 5.9 |
| **Frontend** | React 19, Jotai, RxJS, BlockSuite (Lit), vanilla-extract |
| **Backend** | NestJS 11, Prisma 6, PostgreSQL 16, Redis, Manticore |
| **Native** | Rust napi-rs (`@affine/native`, `@affine/server-native`) |
| **Testing** | Vitest (FE), AVA (BE), Playwright (E2E) |

## Workspace

```
affine/
├── blocksuite/         # Block editor engine (61 packages)
│   ├── affine/         # Blocks (20), gfx (11), widgets (16), inlines (7)
│   ├── framework/      # global, std, store, sync
│   └── playground/
├── packages/
│   ├── frontend/       # core, component, apps (web/electron/mobile), i18n, routes
│   ├── backend/        # server (NestJS), native (Rust)
│   └── common/         # infra (DI), graphql, env, error, nbstore, reader
├── tests/              # 8 E2E suites
└── tools/              # CLI, changelog, commitlint
```

## Skills (load on demand via `skill` tool)

| Skill | When to load |
|---|---|
| `affine-infra-framework` | DI, LiveData, ORM, Op RPC |
| `affine-frontend` | Modules, commands, routing, state |
| `affine-blocksuite` | Blocks, editor, sync engine |
| `affine-component-lib` | UI components, modals, DnD, theme |
| `affine-backend` | NestJS, API, models, Prisma |
| `affine-graphql` | GraphQL queries, codegen, fetcher |

## Key Conventions

- RxJS observables: suffix `$` (data$, state$)
- Block flavours: `affine:block-name` (e.g., `affine:paragraph`)
- DI in `@toeverything/infra`: Service/Store/Entity/Scope + fluent builder
- DI in BlockSuite: separate system, `Container` + `createIdentifier<T>()` + `ExtensionType.setup(di)`
- LiveData for reactive domain state, Jotai for UI-local/global settings
- BE models: proxy-based centralized data access (`Models.User`, `Models.Workspace`)
- BE GraphQL: `@Resolver()`, `@Query()`, `@Mutation()`, `@Public()`, `@Throttle()`
- Platform-split components: `BUILD_CONFIG.isMobileEdition ? Mobile : Desktop`
- GraphQL: write `.gql` files, codegen produces typed runtime objects

## Testing

| Type | Tool | Config |
|---|---|---|
| Frontend unit | Vitest | `vitest.config.ts` (root + per-package) |
| Backend | AVA | `packages/backend/server/ava.config.js` |
| E2E | Playwright | `tests/*/playwright.config.ts` |

Test files: `*.spec.{ts,tsx}`.

## Key Paths

| Purpose | Path |
|---|---|
| DI framework | `packages/common/infra/src/framework/` |
| Frontend core | `packages/frontend/core/src/modules/` |
| Component lib | `packages/frontend/component/src/ui/` |
| BlockSuite blocks | `blocksuite/affine/blocks/` |
| BlockSuite framework | `blocksuite/framework/` |
| BE server | `packages/backend/server/src/` |
| BE models | `packages/backend/server/src/models/` |
| Prisma schema | `packages/backend/server/schema.prisma` |
| GraphQL client | `packages/common/graphql/src/` |
