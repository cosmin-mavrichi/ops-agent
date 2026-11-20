# ops-agent

Own AI ops agent for self-hosted infra. v1 = read-only diagnosis.

## Setup

Node version is pinned in `.nvmrc` (Node 26 LTS); package manager is pnpm (pinned in `package.json`).

```
nvm use            # or: nvm install
npm i -g pnpm@12   # once per Node version (Node 26 has no corepack)
pnpm install       # from the repo root; it is a pnpm workspace
```

## Configuration

All settings are environment variables. stdout is the MCP channel; logs go to stderr.

| Variable                                | Required | Meaning                                                                                          |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `OPS_PG_URL`                            | yes      | Postgres URL as the `ops_ro` role (`deploy/sql/ops_ro.sql`)                                      |
| `OPS_REDIS_URL`                         | no       | Redis or Valkey URL as the `ops_ro` ACL user (`deploy/redis/ops-ro.acl`); unset = no Redis tools |
| `OPS_K8S_NAMESPACES`                    | no       | comma-separated namespaces the agent may inspect; unset = no Kubernetes tools                    |
| `OPS_K8S_SERVER`                        | no       | API server URL when running outside the cluster (in a pod the ServiceAccount provides it)        |
| `OPS_K8S_TOKEN_FILE`, `OPS_K8S_CA_FILE` | no       | override the mounted ServiceAccount token and CA paths                                           |
| `OPS_KNOWN_SECRETS`                     | no       | comma-separated values scrubbed verbatim from all output                                         |
| `OPS_MAX_LEVEL`                         | no       | must be `1` (read-only) in v1; anything higher refuses to boot                                   |

Passwords in `OPS_PG_URL` and `OPS_REDIS_URL` are scrubbed from output automatically.

## Layout (so far)

```
packages/mcp-server/                the only code that touches infra
  src/registry.ts                   level gating + call pipeline (validate → timeout → redact → truncate → audit)
  src/adapters/pg.ts                read-only pool (ops_ro role, read-only session, statement timeout)
  src/adapters/k8s.ts               read-only Kubernetes client (GET only, ServiceAccount token)
  src/adapters/redis.ts             read-only Redis/Valkey client (command allowlist, ops_ro ACL user)
  src/tools/postgres/slow-queries.ts  pg_slow_queries — the reference tool; copy its shape
  src/tools/postgres/               shared (session columns), activity, blocking
  src/tools/k8s/                    shared (namespace allowlist), pods, events, logs
  src/tools/redis/                  shared (INFO parsing, key masking), health, slowlog
  src/lib/sql-text.ts               strips literals/comments from live query text
  test/harness.ts                   real MCP server + client over in-memory transport (useHarness in tests)
  test/{unit,integration}/<area>/   tests grouped by area: core, postgres, k8s, redis
  lab/scenarios/<area>/             fault lab scenarios
deploy/sql/ops_ro.sql    one-time Postgres role setup
deploy/k8s/ops-ro.yaml   read-only ServiceAccount + RBAC for the agent
deploy/redis/ops-ro.acl  read-only, keyless ACL user for Redis/Valkey
```

## Tests

| Layer          | Command                           | Needs            | What it proves                                                                                                      |
| -------------- | --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1. Unit        | `pnpm test`                       | nothing          | gating, input validation, redaction, timeouts, error hiding, SQL whitelisting                                       |
| 2. Integration | `pnpm test:int`                   | Docker           | each tool against the real service in a throwaway container (Testcontainers)                                        |
| 3. Fault lab   | `pnpm lab` (`SCENARIO=…` for one) | Docker           | break one thing in a fresh k3s + Postgres + Valkey; the tools must surface the evidence, no planted secret may leak |
| 4. Agent evals | `pnpm eval` (later)               | Docker + API key | the model finds the root cause, uses only allowed tools, stays under budget                                         |

Rule for adding a tool: unit test with a fake adapter + integration test against the real
service + at least one secret planted in its fixture that must not come out.
