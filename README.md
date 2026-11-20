# ops-agent

Own AI ops agent for self-hosted infra. v1 = read-only diagnosis.

## Setup

Node version is pinned in `.nvmrc` (Node 26 LTS); package manager is pnpm (pinned in `package.json`).

```
nvm use            # or: nvm install
npm i -g pnpm@12   # once per Node version (Node 26 has no corepack)
pnpm install       # from the repo root; it is a pnpm workspace
```

## Layout (so far)

```
packages/mcp-server/                the only code that touches infra
  src/registry.ts                   level gating + call pipeline (validate → timeout → redact → truncate → audit)
  src/adapters/pg.ts                read-only pool (ops_ro role, read-only session, statement timeout)
  src/adapters/k8s.ts               read-only Kubernetes client (GET only, ServiceAccount token)
  src/tools/postgres/slow-queries.ts  pg_slow_queries — the reference tool; copy its shape
  src/tools/postgres/               shared (session columns), activity, blocking
  src/tools/k8s/                    shared (namespace allowlist), pods, events, logs
  src/lib/sql-text.ts               strips literals/comments from live query text
  test/harness.ts                   real MCP server + client over in-memory transport (useHarness in tests)
  test/{unit,integration}/<area>/   tests grouped by area: core, postgres, k8s
  lab/scenarios/<area>/             fault lab scenarios
deploy/sql/ops_ro.sql    one-time Postgres role setup
deploy/k8s/ops-ro.yaml   read-only ServiceAccount + RBAC for the agent
```

## Tests

| Layer          | Command                           | Needs            | What it proves                                                                                             |
| -------------- | --------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| 1. Unit        | `pnpm test`                       | nothing          | gating, input validation, redaction, timeouts, error hiding, SQL whitelisting                              |
| 2. Integration | `pnpm test:int`                   | Docker           | each tool against the real service in a throwaway container (Testcontainers)                               |
| 3. Fault lab   | `pnpm lab` (`SCENARIO=…` for one) | Docker           | break one thing in a fresh k3s + Postgres; the tools must surface the evidence, no planted secret may leak |
| 4. Agent evals | `pnpm eval` (later)               | Docker + API key | the model finds the root cause, uses only allowed tools, stays under budget                                |

Rule for adding a tool: unit test with a fake adapter + integration test against the real
service + at least one secret planted in its fixture that must not come out.

## License

Proprietary. Copyright (c) 2026 Cosmin Mavrichi, all rights reserved. The source is public for reference only; no use, copying, modification or distribution is permitted without written permission. See [LICENSE](LICENSE).
