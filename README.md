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
packages/mcp-server/     the only code that touches infra
  src/registry.ts        level gating + call pipeline (validate → timeout → redact → truncate → audit)
  src/tools/postgres.ts  pg_slow_queries — the reference tool; copy its shape
  src/adapters/pg.ts     read-only pool (ops_ro role, read-only session, statement timeout)
  test/harness.ts        real MCP server + client over in-memory transport
deploy/sql/ops_ro.sql    one-time Postgres role setup
```

## Tests

| Layer          | Command                      | Needs            | What it proves                                                                |
| -------------- | ---------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| 1. Unit        | `pnpm test`                  | nothing          | gating, input validation, redaction, timeouts, error hiding, SQL whitelisting |
| 2. Integration | `pnpm test:int`              | Docker           | each tool against the real service in a throwaway container (Testcontainers)  |
| 3. Fault lab   | `make lab SCENARIO=…` (next) | Docker           | inject a real failure into a mini stack; tools must surface the evidence      |
| 4. Agent evals | `pnpm eval` (later)          | Docker + API key | the model finds the root cause, uses only allowed tools, stays under budget   |

Rule for adding a tool: unit test with a fake adapter + integration test against the real
service + at least one secret planted in its fixture that must not come out.
