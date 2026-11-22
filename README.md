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

| Variable                                | Required | Meaning                                                                                                                                |
| --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `OPS_PG_URL`                            | yes      | Postgres URL as the `ops_ro` role (`deploy/sql/ops_ro.sql`)                                                                            |
| `OPS_REDIS_URL`                         | no       | Redis or Valkey URL as the `ops_ro` ACL user (`deploy/redis/ops-ro.acl`); unset = no Redis tools                                       |
| `OPS_PROM_URL`                          | no       | Prometheus-compatible query API (Prometheus, VictoriaMetrics, Mimir, Thanos); needs `OPS_K8S_NAMESPACES` too; unset = no metrics tools |
| `OPS_K8S_NAMESPACES`                    | no       | comma-separated namespaces the agent may inspect; unset = no Kubernetes tools                                                          |
| `OPS_K8S_SERVER`                        | no       | API server URL when running outside the cluster (in a pod the ServiceAccount provides it)                                              |
| `OPS_K8S_TOKEN_FILE`, `OPS_K8S_CA_FILE` | no       | override the mounted ServiceAccount token and CA paths                                                                                 |
| `OPS_KNOWN_SECRETS`                     | no       | comma-separated values scrubbed verbatim from all output                                                                               |
| `OPS_KNOWN_SECRETS_DIR`                 | no       | directory with one value per file (a mounted Kubernetes Secret), scrubbed the same way                                                 |
| `OPS_MAX_LEVEL`                         | no       | must be `1` (read-only) in v1; anything higher refuses to boot                                                                         |

Passwords in `OPS_PG_URL`, `OPS_REDIS_URL` and `OPS_PROM_URL` are scrubbed from output automatically.

### Redacting the applications' own secrets

Patterns only catch secrets in recognisable forms (`password=…`, URLs with credentials, bearer tokens, JWTs). An
application that logs its own secret in free text (`ERROR auth failed using hunter2-prod`) is only redacted if
the agent knows the value. Mount the application's Secret into the ops pod and point `OPS_KNOWN_SECRETS_DIR` at it:

```yaml
volumes:
  - name: known-secrets
    secret: { secretName: app-secrets-for-ops }
containers:
  - name: ops-agent
    env: [{ name: OPS_KNOWN_SECRETS_DIR, value: /var/run/secrets/ops-known }]
    volumeMounts: [{ name: known-secrets, mountPath: /var/run/secrets/ops-known, readOnly: true }]
```

- The values are used only to build the redactor: never logged, never shown to the model, never in the audit log.
  Values shorter than 6 characters are skipped with a warning naming the file (redacting them would shred normal
  text).
- `deploy/k8s/ops-ro.yaml` is unchanged: the agent still can't read Secrets through the API. The values arrive
  as a volume.
- **A Secret volume can only mount a Secret from the pod's own namespace.** The app's Secret lives in `app`, the
  ops pod in `ops`, so the values have to be copied into `ops`: create both Secrets from the same source (your
  secret manager or sealed secrets), or use a replicator. This repo doesn't do that for you.
- Trade-off: the ops pod now holds the app's secrets in memory. Whoever compromises the ops pod can read them.
- Values are read once at boot; after rotating a secret, restart the agent.

## Layout (so far)

```
packages/mcp-server/                the only code that touches infra
  src/registry.ts                   level gating + call pipeline (validate → timeout → redact → truncate → audit)
  src/adapters/pg.ts                read-only pool (ops_ro role, read-only session, statement timeout)
  src/adapters/k8s.ts               read-only Kubernetes client (GET only, ServiceAccount token)
  src/adapters/redis.ts             read-only Redis/Valkey client (command allowlist, ops_ro ACL user)
  src/adapters/prometheus.ts        Prometheus-compatible query API client (instant queries only)
  src/tools/postgres/slow-queries.ts  pg_slow_queries — the reference tool; copy its shape
  src/tools/postgres/               shared (session columns), activity, blocking
  src/tools/k8s/                    shared (namespace allowlist), pods, events, logs
  src/tools/redis/                  shared (INFO parsing, key masking), health, slowlog
  src/tools/prometheus/             volume-usage (PersistentVolumeClaim disk usage)
  src/lib/sql-text.ts               strips literals/comments from live query text
  test/harness.ts                   real MCP server + client over in-memory transport (useHarness in tests)
  test/{unit,integration}/<area>/   tests grouped by area: core, postgres, k8s, redis, prometheus
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

## License

Proprietary. Copyright (c) 2026 Cosmin Mavrichi, all rights reserved. The source is public for reference only; no use, copying, modification or distribution is permitted without written permission. See [LICENSE](LICENSE).
