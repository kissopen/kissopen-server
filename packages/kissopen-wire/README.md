# KissOpen wire protocol

Shared Zod schemas and TypeScript types for KissOpen clients and the encrypted
relay. This package contains no UI or Agent execution code.

Build with `pnpm --filter @kissopen/kissopen-wire build` from the workspace root.
Clients should adopt a reviewed versioned artifact; never import a sibling
repository's source at runtime. Package publication is disabled in this local
extraction candidate. Upstream MIT attribution is preserved in LICENSE.
