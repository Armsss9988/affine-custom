# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

AFFiNE is a privacy-first, open-source knowledge management system that combines notes, docs, and wikis with blocks-based editing (BlockSuite) and AI assistance (Copilot).

## Tech Stack

| Layer        | Technologies                                                                 |
| ------------ | ---------------------------------------------------------------------------- |
| **Monorepo** | Yarn 4 (PnP mode), TypeScript 5.9                                            |
| **Frontend** | React 19, Jotai (state), RxJS (async), BlockSuite (editor), Lit (components) |
| **Backend**  | Node.js, NestJS 11, Prisma 6, PostgreSQL 16, Redis, Manticore                |
| **Native**   | Rust via napi-rs (`@affine/native`, `@affine/server-native`)                 |
| **Testing**  | Vitest (frontend), AVA (backend), Playwright (E2E)                           |
| **Linting**  | oxlint, ESLint 9, Prettier, TAPLO (Rust)                                     |

## Workspace Structure

```
affine/
├── blocksuite/              # Core block-based collaborative editing engine
│   ├── affine/              # AFFiNE-specific blocks, specs, views
│   └── packages/            # BlockSuite packages
├── packages/
│   ├── frontend/
│   │   ├── apps/            # web, electron, mobile, admin
│   │   ├── core/            # Main workspace UI, bootstrap, commands
│   │   ├── component/       # Shared UI components
│   │   ├── routes/          # Page routing configuration
│   │   ├── i18n/            # Internationalization
│   │   └── ...
│   ├── backend/
│   │   ├── server/          # NestJS API server (GraphQL + REST)
│   │   └── native/          # Rust NAPI bindings server
│   └── common/
│       ├── infra/            # DI framework, LiveData, Op RPC, ORM
│       ├── graphql/          # GraphQL client & types
│       ├── env/             # Environment config
│       └── ...
├── .docker/
│   ├── dev/                 # Docker Compose for local dev
│   └── selfhost/            # Self-hosted deployment config
├── scripts/                 # Build & dev scripts
├── tests/                   # E2E tests (Playwright)
└── tools/                   # Dev tools, CLI
```

## Quick Start

```bash
# After git clone
yarn install
yarn affine init

# Development
yarn dev                   # Start web dev server (localhost:3000)

# Backend development (requires Docker)
cp .docker/dev/.env.example .env  # Configure DB credentials
docker compose -f .docker/dev/compose.yml.example up -d
yarn affine server dev     # Start API server (localhost:8080)

# Testing
yarn test                  # Unit tests (all packages)
yarn test --filter @affine/core  # Test specific package
yarn workspace @affine/server test  # Backend tests (AVA)

# Linting
yarn lint                  # oxlint + eslint + prettier
yarn lint:fix              # Auto-fix

# Type checking
yarn typecheck             # TSC with all project references
```

## Development Commands (via `yarn affine`)

```bash
# Build
yarn affine build                   # Build all packages
yarn affine build -p @affine/core   # Build specific package

# Native modules
yarn affine @affine/native build
yarn affine @affine/server-native build

# Server
yarn affine server dev        # Start backend (needs Docker)
yarn affine server build      # Production build
yarn affine server init       # DB migrate + seed

# Generators
yarn affine gen               # Run code generators
```

## Architecture Patterns

### State Management (Frontend)

**Three layers working together:**

1. **Jotai Atoms** - Global atomic state for React components

   ```ts
   const countAtom = atom(0);
   const doubledAtom = atom(get => get(countAtom) * 2);
   ```

2. **LiveData** (`@toeverything/infra`) - Reactive state with hooks

   ```ts
   // Entity pattern
   import { LiveData } from '@toeverything/infra';
   const data$ = new LiveData(initialValue);
   ```

3. **RxJS Observables** - Async operations, streams
   ```ts
   // Convention: observables end with $
   const data$ = this.service.data$.pipe(
     map(x => transform(x)),
     catchError(err => of(defaultValue))
   );
   ```

### Dependency Injection (Infra Framework)

```ts
// packages/common/infra/src/framework/
// constructor-context.ts  - DI container
// scope.ts               - Service scopes (singleton, transient)
// service.ts             - @Service decorator pattern

import { Service } from '@toeverything/infra';

@Service()
class MyService {
  constructor() {
    // Dependencies injected via constructor
  }
}
```

### BlockSuite Extension

```ts
// blocksuite/affine/ - AFFiNE-specific blocks built on BlockSuite
// Block specs, services, and views follow BlockSuite conventions
// Uses Lit for block-level UI components
```

### Backend API (GraphQL + REST)

```ts
// GraphQL resolvers in packages/backend/server/src/core/
// REST controllers in packages/backend/server/src/modules/
// Uses NestJS with Prisma ORM
```

## Testing Guidelines

### Frontend Tests (Vitest)

```ts
// Test file pattern: *.spec.{ts,tsx}
// Location: Collocated with source files or in __tests__/

import { describe, it, expect } from 'vitest';

describe('MyFeature', () => {
  it('should work', () => {
    expect(true).toBe(true);
  });
});
```

### Backend Tests (AVA)

```ts
// Test file pattern: *.spec.ts
// Location: packages/backend/server/src/__tests__/

import { before, after, test } from 'ava';

test.before(async t => {
  // Setup
});

test.after.always(() => {
  // Cleanup
});

test('should work', async t => {
  t.true(true);
});
```

### E2E Tests (Playwright)

```bash
# Run E2E tests
yarn workspace @affine-test/affine-local e2e
```

## Database

- **ORM**: Prisma 6
- **Schema**: `packages/backend/server/schema.prisma`
- **Migrations**: `packages/backend/server/migrations/`
- **Run after migration**: `yarn affine server init`

## Docker Services (Local Dev)

Required services running via Docker Compose:

| Service               | Port      | Purpose          |
| --------------------- | --------- | ---------------- |
| PostgreSQL (pgvector) | 5432      | Primary database |
| Redis                 | 6379      | Caching, queues  |
| Manticore             | 9308      | Full-text search |
| Mailpit               | 1025/8025 | Email testing    |

Start services:

```bash
cp .docker/dev/compose.yml.example .docker/dev/compose.yml
docker compose -f .docker/dev/compose.yml up -d
```

## Self-Host Deployment

See `.docker/selfhost/` for production deployment:

- Uses nginx as reverse proxy
- Includes RAG Chatbot with NVIDIA NIM integration
- Configuration via `config.json`

## Code Conventions

### Naming

- **RxJS observables**: End with `$` (e.g., `data$`, `state$`)
- **React components**: PascalCase (e.g., `WorkspacePage.tsx`)
- **Non-component files**: kebab-case or camelCase

### Patterns

- Immutability for Jotai atoms
- Use Infra framework DI for services
- Sorted imports, no side-effect imports in production
- Decorator-based DI for NestJS services (`@Injectable()`, `@Resolver()`, etc.)

### TypeScript

- Strict mode enabled
- Use `zod` for runtime validation
- Prefer explicit types over `any`

## Git Workflow

```bash
# Using rtk (Rust Token Killer) for optimized git operations
rtk git status
rtk git add .
rtk git commit -m "feat: description"
rtk git push
```

## Key Files Reference

| Purpose           | Path                                                       |
| ----------------- | ---------------------------------------------------------- |
| Package list      | `yarn workspace` commands                                  |
| Prisma schema     | `packages/backend/server/schema.prisma`                    |
| TypeScript config | `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json` |
| ESLint config     | `eslint.config.mjs`                                        |
| Vite config       | `vite.config.ts`, block packages                           |
| Vitest config     | `vitest.config.ts`                                         |
| Docker dev setup  | `.docker/dev/compose.yml.example`                          |
| Docker selfhost   | `.docker/selfhost/compose.yml`                             |
