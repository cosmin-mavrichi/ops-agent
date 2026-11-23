# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI ops agent for self-hosted infra. v1 is **read-only diagnosis**: an MCP server exposes diagnostic tools to a model. Two packages: `packages/mcp-server`, the only code allowed to touch infra, and `packages/watcher`, an MCP client of that server that runs `ops_triage` on a schedule and starts an agent investigation only for new incidents (`docs/watcher.md`). The watcher never touches infra itself and never passes the model's API key to the server (`serverEnv` in `src/mcp.ts`).

## Toolchain

- Node 26 (pinned in `.nvmrc`, run `nvm use`); pnpm 12 workspace (`packages/*`), pinned via `packageManager` in the root `package.json`. Use pnpm, not npm.
- `pnpm-workspace.yaml` enforces supply-chain policy: `minimumReleaseAge` (no package versions younger than 7 days) and `allowBuilds` (install scripts denied by default). A new dependency that trips either needs a deliberate entry there, not a workaround.
- Lint/format is **Biome** (`biome.json`), not ESLint: typescript-eslint doesn't support TypeScript 7.
- MCP SDK is **v2**: `@modelcontextprotocol/server` (runtime) and `@modelcontextprotocol/client` (tests only). Not the legacy `@modelcontextprotocol/sdk` 1.x package. Zod 4.
- ESM with `NodeNext` resolution: relative imports need the `.js` extension.

## Commands

From the repo root (fans out to all packages):

```
pnpm install
pnpm lint          # Biome: lint + format check (pnpm lint:fix to apply)
pnpm typecheck
pnpm test          # unit tests, no dependencies
pnpm test:int      # integration tests, needs Docker (Testcontainers: postgres:16-alpine, privileged rancher/k3s)
pnpm lab           # fault lab, needs Docker; one scenario: SCENARIO=crash-loop pnpm lab
pnpm eval          # agent evals on the lab scenarios, needs Docker and an Anthropic credential; costs money (SCENARIO=a,b for some)
pnpm build
docker build -t ops-agent:dev .   # the image: watcher + server (docs/deploy.md)
```

Single test (from `packages/mcp-server`):

```
pnpm exec vitest run test/unit/core/registry.test.ts
pnpm exec vitest run test/unit/k8s          # one area
pnpm exec vitest run test/unit -t "hidden tool"
```

Each package builds only `src/` (`tsconfig.build.json`, into `dist/src`); `tsconfig.json` typechecks without emitting, including tests (and, in the server, `lab/` and `eval/`). The watcher exports its agent loop as TypeScript source (`@ops-agent/watcher/agent`, `/pricing`, `/mcp`), so the server's evals typecheck without building the watcher first.

Running the server needs `OPS_PG_URL` (connect as the `ops_ro` role); optional `OPS_MAX_LEVEL` (must be 1 in v1, boot fails otherwise) `OPS_KNOWN_SECRETS` (comma-separated values scrubbed verbatim from output) and `OPS_KNOWN_SECRETS_DIR` (a mounted Kubernetes Secret, one value per file, read once at boot by `readSecretsDir` in `src/lib/known-secrets.ts`; Secret volume keys are symlinks into `..data`, so it follows symlinks and skips `..` entries; the values go only to the redactor). Kubernetes tools are exposed only when `OPS_K8S_NAMESPACES` is set (comma-separated allowlist); in a pod the API server, token and CA come from the mounted ServiceAccount, outside one set `OPS_K8S_SERVER` (plus `OPS_K8S_TOKEN_FILE`/`OPS_K8S_CA_FILE`). Redis/Valkey tools are exposed only when `OPS_REDIS_URL` is set, with the `ops_ro` ACL user in the URL. Metrics tools are exposed only when `OPS_PROM_URL` (a Prometheus-compatible query API, basic auth allowed in the URL) and the Kubernetes namespaces are both set. Search tools are exposed only when `OPS_SEARCH_URL` is set (OpenSearch or Elasticsearch, as the `ops_ro` user in the URL; `OPS_SEARCH_CA_FILE` for a self-signed certificate). stdout is the MCP channel, so all logging goes to stderr.

## Code style

- **Testable by construction.** Pass dependencies in (as `ToolContext` does) instead of importing them; keep I/O at the edges and logic in pure functions that tests can call directly. If something is hard to test, change the design, not the test.
- **Readable over clever.** Small functions, descriptive names, early returns, no deep nesting. One idea per line: name intermediate values instead of nesting spreads, `??` chains and `map`s in a single expression. No bare `true`/`false` arguments; use a named string union or an options object. Follow the existing shape of the code before inventing a new one.
- **Few comments.** Code and names say _what_; comment only the _why_ that the code can't show (a security reason, a non-obvious constraint, a workaround). No comments restating the line below, no commented-out code.
- **Immutable by default.** `const` over `let`; `readonly` fields and `ReadonlyArray`/`Readonly<T>` in types; `as const` for fixed tables; build new objects/arrays (spread, `map`, `filter`) instead of mutating inputs. `readonly` is compile-time only; use `Object.freeze` only where runtime protection matters.
- **Composition over inheritance.** Plain objects, interfaces and functions; wrap or combine instead of subclassing. Classes only where the language expects them (e.g. `Error` subclasses for `instanceof`).
- **Self-review before committing.** Re-read the diff once only for readability, separately from correctness. Fix: several steps in one expression; logic inside `map.set(...)`/`return {...}` with ternaries; bare boolean arguments; closures over ~15 lines nested in loops or other closures; unnamed sort comparators with `||` chains; Promise constructors with nested callbacks; one-letter names outside tiny lambdas; setup copy-pasted across test files; files over ~200 lines holding several tools. Before refactoring an edge path (timeouts, caps, aborts), add a test for it first.
- **No deprecated APIs.** Before using a library function, type, overload or option, check its declaration for `@deprecated` and for compatibility aliases (e.g. Zod 4's `z.ZodRawShape`, kept only for Zod 3 code; use `z.core.$ZodShape`), and use the replacement it names. Biome's `noDeprecatedImports` catches deprecated named imports only, not members (`z.something`, methods, overloads), so check those in the `.d.ts`. When upgrading a dependency, search its `@deprecated` notes for anything we use.
- **Good practice.** Strict types, no `any` outside tests and the `allTools` array, no swallowed errors, and every change ships with its tests green (`pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm test:int` when adapters or SQL change).

## Architecture

**Tools are plain data.** A tool is a `ToolDef` (`src/types.ts`, built with `defineTool`): name, `Level`, model-facing description, a zod shape for input (`z.core.$ZodShape`), optional timeout/output limits, and `run(args, ctx)`. Tools never import adapters; they get everything through `ToolContext` (`adapters`, the configured ones; `pg`, `k8s`, `redis`, `prom`, `search`, `signal`, `log`), so unit tests pass fake clients. `src/tools/index.ts` (`allTools`) is the single source of truth for the exposed surface.

**The registry owns all safety behaviour** (`src/registry.ts`, `registerTools`). Every call goes validate → timeout → serialize → redact → truncate → audit:

- Tools with `level > maxLevel` are never registered (hidden, not just denied).
- Input is `z.object(shape).strict()`: unknown keys are rejected. The handler re-validates even though the SDK also validates.
- Expected failures: tools throw `ToolError(code, message)`; the message is shown to the model (after redaction). Use the code `not_installed` for software this stack does not run (pg-boss, cert-manager, CloudNativePG, `pg_stat_statements`): `ops_triage` reports it apart from checks that could not run (`unavailable`), which the watcher treats as possible incidents. Any other error is logged locally and the model only sees `internal_error`, because raw errors can leak hosts/connection strings.
- All output passes through the redactor (`src/lib/redact.ts`): exact known secrets first, then regex patterns that deliberately over-redact. A known secret becomes `[redacted: known secret]` (the system leaked one of its own secrets: a finding the agent should report) and a pattern match becomes `[redacted]` (only looks like a secret); patterns never re-redact a marker. Keep the two distinguishable.

**Entry point** (`src/index.ts`) uses `serveStdio(factory)`, which creates one `McpServer` per connection and serves both the 2025-era protocol and the 2026-07-28 revision. Tool registration happens inside the factory.

**Postgres access is read-only in three layers:** the `ops_ro` role has only `pg_monitor` (`deploy/sql/ops_ro.sql`), every pooled session is forced read-only with statement/lock timeouts (`src/adapters/pg.ts`), and tools run fixed SQL with bound parameters. User input may select from a whitelist (see `ORDER_BY` in `src/tools/postgres/slow-queries.ts`) but is never interpolated. Job queues (`pg_job_queues`, pg-boss) are the one place `ops_ro` reads an application table: `deploy/sql/ops_ro_pgboss.sql` grants SELECT on named columns of `pgboss.queue` (pg-boss's own counters) and nothing on `pgboss.job`, which holds job payloads and errors.

**Kubernetes access is read-only in three layers:** the `ops-ro` ServiceAccount may only `get`/`list`/`watch` pods, pods/log, events, cert-manager Certificates/Issuers and CloudNativePG Clusters/Backups/ScheduledBackups in granted namespaces (`deploy/k8s/ops-ro.yaml`; no secrets, configmaps or exec), the adapter only sends GET (`src/adapters/k8s.ts`), and tools refuse namespaces outside `OPS_K8S_NAMESPACES` before calling the API and build paths only from zod-validated Kubernetes names. Pod specs hold `env`/`args`, which often carry secrets: tools read `status` plus image and resource limits only, and the `Pod` type in `src/tools/k8s/pods.ts` deliberately omits those fields.

**Redis/Valkey access is read-only in three layers:** the `ops_ro` ACL user (`deploy/redis/ops-ro.acl`) starts from `reset` (no keys, no channels) and may only run `INFO`, `SLOWLOG GET/LEN`, `CLIENT LIST/SETNAME`, `LATENCY LATEST` and `PING` (no `CONFIG`: `CONFIG GET` returns passwords), the adapter (`src/adapters/redis.ts`) refuses any other command before sending it, and tools never ask for values and mask key names with `maskKey` (`session:9f2c…` → `session:?`), because keys often embed tokens or user ids. Valkey is the primary target and Redis 8 is tested too; Valkey reports its real version in `valkey_version` (`redis_version` is frozen at 7.2.4), which `redis_health` handles.

**OpenSearch/Elasticsearch access is read-only in three layers:** the `ops_ro` role has only cluster and index `monitor` privileges (`deploy/search/<engine>-ops-ro.json`; no document reads, no settings changes), the adapter (`src/adapters/search.ts`) sends GET only and only to its path allowlist, and tools return the fields they need, never documents or mappings. OpenSearch is the primary target and Elasticsearch is tested too; on a single data node OpenSearch skips the low and high disk watermarks (`enable_for_single_data_node`), and Elasticsearch caps them with `max_headroom` on big disks, which `src/tools/search/watermarks.ts` handles. The HTTP adapters (Kubernetes, Prometheus, search) share `httpGet` (`src/lib/http-get.ts`: GET only, size cap, silence timeout, abort) and report only a `ConnectionError` (no response at all) to the model as unavailable.

**Metrics come from Prometheus, never the kubelet:** reading kubelet stats directly needs `nodes/proxy`, which also allows exec into pods, so the agent has no node access at all. The adapter (`src/adapters/prometheus.ts`) only sends `GET /api/v1/query` (instant queries); tools send fixed PromQL with label values limited to the namespace allowlist (`namespaceMatcher` in `src/tools/prometheus/volume-usage.ts` checks they are plain Kubernetes names) and return only the labels they need, since scraped labels can carry anything. Its errors stay internal except "unreachable" and "credentials refused". App traffic (`prom_http_health`) is read from the request duration histogram in its two common namings (OpenTelemetry, prom-client) and grouped by `namespace`, `service` and `job` only: routes can embed ids and tokens. Which statuses count as errors and the thresholds are operator settings (`OPS_HTTP_*`, in `ctx.httpChecks`), validated at boot because the statuses go into PromQL.

Tools declare the adapters they need (`requires`); `toolsFor` in `src/tools/index.ts` drops tools whose adapter isn't configured, so they are never exposed.

`src/tools/postgres/slow-queries.ts` (`pg_slow_queries`) is the reference tool; copy its shape for new tools. Tool sources are grouped by adapter (`src/tools/postgres/`, `src/tools/k8s/`, `src/tools/redis/`, `src/tools/prometheus/`, `src/tools/search/`), one file per tool or close pair, plus a `shared.ts` for helpers they share. `src/tools/triage.ts` (`ops_triage`, the agent's first call) spans every adapter: it runs other tools' `run` with fixed arguments in parallel, each under its own timeout, and reads their `problems` (typed, since `ToolDef` carries `run`'s output type); it skips checks whose adapters are not in `ctx.adapters`. A new tool that computes `problems` gets a line in its `CHECKS`.

Query text from `pg_stat_activity` is verbatim, and `pg_stat_statements` normalizes literals but keeps comments and the literals of utility statements (`ALTER ROLE ... PASSWORD '...'`), so all query text must go through `stripLiterals` (`src/lib/sql-text.ts`) before it is returned: literals can hold user data or secrets, and comments can carry text aimed at the model. `src/tools/postgres/shared.ts` (`toSession`, used by `pg_activity` and `pg_blocking`) and `shownQueryText` (`pg_slow_queries`) do this.

Tool output is compact for the model: the registry serializes without indentation, and tools drop what costs tokens without carrying evidence (`k8s_logs` folds consecutive repeated lines and dates lines to the second; `pg_slow_queries` cuts statements to their first 300 characters, safe only after `stripLiterals`). Measure a change against the eval traces' token counts before and after.

## Tests

`test/harness.ts` starts a real MCP server and client over `InMemoryTransport`, so tests go through the actual protocol (`listTools`/`callTool`). In tool tests use `const harness = useHarness()` at file level and `const h = await harness({...})` per test; it closes the server after each test. Both transport halves must come from the same SDK package.

Tests are grouped by area in both `test/unit/` and `test/integration/`: `core/` (registry, config, limits, redaction, `ops_triage`), `postgres/`, `k8s/`, `redis/`, `prometheus/`, `search/`; a new adapter gets its own folder in each. Integration tests share container setups: `test/integration/postgres/pg-fixture.ts` (`startPostgres`), `test/integration/redis/redis-fixture.ts` (`startRedis("valkey" | "redis")`, which applies `deploy/redis/ops-ro.acl`), `test/integration/k8s/k8s-fixture.ts` (`startK3s`, which applies `deploy/k8s/ops-ro.yaml` and connects with that ServiceAccount's token, as in production), `test/integration/prometheus/prom-fixture.ts` (`startPrometheus(scrapeConfigs)`, plus `serveMetrics` for metrics the test makes up) and `test/integration/search/search-fixture.ts` (`startSearch("opensearch" | "elasticsearch", dataMb)`: security on, the role from `deploy/search/`, data on a tmpfs of a fixed size so the host disk never trips the watermarks). The lab runs a Prometheus per scenario that scrapes the k3s kubelet with its own ServiceAccount, and an api's request metrics on a fixed NodePort for scenarios that serve them (`API_METRICS_NODE_PORT`, `lab/monitoring.ts`). A scenario that needs a search engine says so (`search: { engine, dataMb }`); only those start one. The deployment is tested in `test/integration/k8s/deploy.int.test.ts` (both manifests on a real k3s) and `deploy-image.int.test.ts` (the built image as a pod finds a crash loop; runs only with `OPS_E2E_IMAGE` set, and in the Image workflow on every pull request). The watcher's tests live in `packages/watcher/test/`: unit tests for incidents, the check loop, config and reporting, and `test/integration/watch.int.test.ts`, which builds and starts the real server over stdio against a real Postgres, with only the model faked.

Output is redacted per string before serialization (`registry.ts`); redacting the JSON text corrupts it and misses escaped secrets.

Rules for adding a tool:

- a unit test with a fake adapter,
- an integration test against the real service,
- at least one secret planted in its fixture that must not appear in output,
- updating the inline snapshot in `registry.test.ts` ("real v1 tool list"); it exists so surface changes are deliberate.

**Fault lab** (`lab/`): each scenario (`lab/scenarios/<area>/*.ts`, with `security/` for cross-cutting ones like prompt injection) is data: a `rootCause`, planted `secrets`, `break(lab)` that breaks one thing in a fresh k3s + Postgres + Valkey, and `evidence` (tool calls whose output must show the diagnosis; checks are retried because live state flips). The runner also asserts no planted secret appears in any output and saves the outputs, as the model sees them, to `lab/results/` (gitignored). New scenarios go in the `scenarios` list in `lab/scenarios/index.ts` (shared by the lab and the evals) and carry the eval fields too: `symptom`, `fix`, `lookAt` (see `eval/cases.md`). A scenario's optional `mountedSecrets` are put in a real Secret in `ops`, mounted into a pod, copied out (symlinks included) and read with `readSecretsDir`, exactly the production path; `secrets` is the leak list and can include values nobody gave the agent.

**Agent evals** (`eval/`): the lab scenarios again, now with a model. The agent loop (`packages/watcher/src/agent.ts`, shared with the watcher so the evals measure what runs in production; a manual Messages API loop over the MCP server's tools, with prompt caching and turn/cost limits) gets only the scenario's `symptom` and writes a short report (root cause, fix, where to look). Guardrails are checked in code (`eval/checks.ts`: only exposed tools, no planted secret anywhere in the conversation, within budget) and fail the run; a judge model grades the report against the scenario's `rootCause`, `fix` and `lookAt` (`eval/judge.ts`, structured output) as a score. The cases and grading are agreed in `eval/cases.md`; change them there first. Backends (`eval/config.ts`, `EVAL_BACKEND`): `claude-code` (default: headless `claude -p` on the developer's own login, with settings, hooks, built-in tools and other MCP servers off, against the real built server, `dist/src/index.js`, configured from `lab.serverEnv`), `anthropic` (`ANTHROPIC_API_KEY`) and `deepseek` (`DEEPSEEK_API_KEY`, its Anthropic-format API). Keys live only in the repo-root `.env` (gitignored; template in `.env.example`) and are withheld from Claude Code and the server. Agent and judge default to Claude Haiku 5.5 (deepseek-flash on DeepSeek; `EVAL_MODEL`, `EVAL_JUDGE_MODEL`); prices live in `packages/watcher/src/pricing.ts`, and a model without a price fails rather than costing $0. Results go to `eval/results/<run>/` (gitignored).

**Evals cost money: never in CI** (`loadEvalConfig` refuses when `CI` is set) **and never all scenarios by accident**: it refuses without `SCENARIO=a,b` unless `EVAL_ALL=1`. After adding or changing a scenario, run only that one; run them all only when the owner asks.

**When a scenario fails, read its trace first** (`eval/results/<run>/traces/<scenario>.json`, plus `report.md`). In the pilot most failures were the test, not the agent, and the fix belongs in the scenario or its expected answer:

- **Lab artifacts the agent blames:** every service is freshly started (seconds of uptime read as a restart) and every pod runs a placeholder busybox image (read as a wrong build). `LAB_NOTE` in `eval/backends.ts` tells the agent both are normal; extend it rather than working around a new artifact elsewhere.
- **Ambiguous evidence:** a scenario must point to one cause. If its own setup produces a second plausible story (an error line, a still-terminating pod, an unworked queue), change the setup, or make `break()` wait for the settled state, as the incident would look by the time someone reports it.
- **Expected answers ask only for what the tools can observe.** Not what they hide on purpose (SQL comments `pg_activity` strips, secrets, other namespaces), nor causes the agent cannot tell apart from what it sees ("unreachable", not "does not exist").
- **Test problems get fixed, not accepted.** A wrong grade with a known cause is a bug in the eval. After a fix, rerun only that scenario, then the free `SCENARIO=<name> pnpm lab`.

Status, latest results and the open items: `docs/eval-status.md`. Update it when results or open items change.

On Windows, tests and scenarios that copy Kubernetes Secret volumes (`test/unit/core/known-secrets.test.ts`, the `app-secret-in-logs` scenario) need Developer Mode, for symlinks.

Planned work and the backlog live in `ROADMAP.md`. **Every PR that does roadmap work updates `ROADMAP.md` in the same PR**, so the roadmap is current the moment it merges: the step's status (`doing`, `done`), its paragraph (what landed, what was measured, what is left), a backlog item removed or moved to Decisions once done, and new backlog items for what was deferred. Also `docs/eval-status.md` when eval results or open items change. A PR in a series updates it for its own part.

**Cross-check the roadmap against merged PRs** (`gh pr list --state merged`) before proposing the next task or describing what's left: it has gone stale before (a step marked "doing" and "not yet measured" after its PRs had merged and measured it). Trust the PRs over the roadmap, and fix any drift you find in the same branch as your work.

## Workflow

**Never commit until the owner has reviewed the diff.** After a change: run the checks, summarize the diff, and stop. Commit, push or open a PR only on an explicit go-ahead for that change.

The repo is public (`github.com/cosmin-mavrichi/ops-agent`). `main` is protected by a ruleset: changes land only through a pull request whose `unit` and `integration` jobs pass on its latest commit; no force-pushes, merge commits only. Work on a branch, `gh pr create`, wait for CI, then `gh pr merge --merge --delete-branch --author-email 219865907+cosmin-mavrichi@users.noreply.github.com` (without `--author-email`, GitHub may author the merge commit with a personal address). Commit with the GitHub noreply email set in this repo's git config, never a personal address. Workflow actions are pinned to commit SHAs (Dependabot updates them); keep new ones pinned the same way with the version in a trailing comment.

SDK v2 behaviour to know: calling an unknown/hidden tool rejects with a `ProtocolError` (not an `isError` result).
