# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI ops agent for self-hosted infra. v1 is **read-only diagnosis**: an MCP server exposes diagnostic tools to a model. Currently the only package is `packages/mcp-server`, the only code allowed to touch infra.

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
pnpm build
```

Single test (from `packages/mcp-server`):

```
pnpm exec vitest run test/unit/core/registry.test.ts
pnpm exec vitest run test/unit/k8s          # one area
pnpm exec vitest run test/unit -t "hidden tool"
```

Running the server needs `OPS_PG_URL` (connect as the `ops_ro` role); optional `OPS_MAX_LEVEL` (must be 1 in v1, boot fails otherwise) and `OPS_KNOWN_SECRETS` (comma-separated values scrubbed verbatim from output). Kubernetes tools are exposed only when `OPS_K8S_NAMESPACES` is set (comma-separated allowlist); in a pod the API server, token and CA come from the mounted ServiceAccount, outside one set `OPS_K8S_SERVER` (plus `OPS_K8S_TOKEN_FILE`/`OPS_K8S_CA_FILE`). stdout is the MCP channel, so all logging goes to stderr.

## Code style

- **Testable by construction.** Pass dependencies in (as `ToolContext` does) instead of importing them; keep I/O at the edges and logic in pure functions that tests can call directly. If something is hard to test, change the design, not the test.
- **Readable over clever.** Small functions, descriptive names, early returns, no deep nesting. One idea per line: name intermediate values instead of nesting spreads, `??` chains and `map`s in a single expression. No bare `true`/`false` arguments; use a named string union or an options object. Follow the existing shape of the code before inventing a new one.
- **Few comments.** Code and names say _what_; comment only the _why_ that the code can't show (a security reason, a non-obvious constraint, a workaround). No comments restating the line below, no commented-out code.
- **Immutable by default.** `const` over `let`; `readonly` fields and `ReadonlyArray`/`Readonly<T>` in types; `as const` for fixed tables; build new objects/arrays (spread, `map`, `filter`) instead of mutating inputs. `readonly` is compile-time only; use `Object.freeze` only where runtime protection matters.
- **Composition over inheritance.** Plain objects, interfaces and functions; wrap or combine instead of subclassing. Classes only where the language expects them (e.g. `Error` subclasses for `instanceof`).
- **Self-review before committing.** Re-read the diff once only for readability, separately from correctness. Fix: several steps in one expression; logic inside `map.set(...)`/`return {...}` with ternaries; bare boolean arguments; closures over ~15 lines nested in loops or other closures; unnamed sort comparators with `||` chains; Promise constructors with nested callbacks; one-letter names outside tiny lambdas; setup copy-pasted across test files; files over ~200 lines holding several tools. Before refactoring an edge path (timeouts, caps, aborts), add a test for it first.
- **Good practice.** Strict types, no `any` outside tests and the `allTools` array, no swallowed errors, and every change ships with its tests green (`pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm test:int` when adapters or SQL change).

## Architecture

**Tools are plain data.** A tool is a `ToolDef` (`src/types.ts`, built with `defineTool`): name, `Level`, model-facing description, a zod raw shape for input, optional timeout/output limits, and `run(args, ctx)`. Tools never import adapters; they get everything through `ToolContext` (`pg`, `signal`, `log`), so unit tests pass fake clients. `src/tools/index.ts` (`allTools`) is the single source of truth for the exposed surface.

**The registry owns all safety behaviour** (`src/registry.ts`, `registerTools`). Every call goes validate → timeout → serialize → redact → truncate → audit:

- Tools with `level > maxLevel` are never registered (hidden, not just denied).
- Input is `z.object(shape).strict()`: unknown keys are rejected. The handler re-validates even though the SDK also validates.
- Expected failures: tools throw `ToolError(code, message)`; the message is shown to the model (after redaction). Any other error is logged locally and the model only sees `internal_error`, because raw errors can leak hosts/connection strings.
- All output passes through the redactor (`src/lib/redact.ts`): exact known secrets first, then regex patterns that deliberately over-redact.

**Entry point** (`src/index.ts`) uses `serveStdio(factory)`, which creates one `McpServer` per connection and serves both the 2025-era protocol and the 2026-07-28 revision. Tool registration happens inside the factory.

**Postgres access is read-only in three layers:** the `ops_ro` role has only `pg_monitor` (`deploy/sql/ops_ro.sql`), every pooled session is forced read-only with statement/lock timeouts (`src/adapters/pg.ts`), and tools run fixed SQL with bound parameters. User input may select from a whitelist (see `ORDER_BY` in `src/tools/postgres/slow-queries.ts`) but is never interpolated.

**Kubernetes access is read-only in three layers:** the `ops-ro` ServiceAccount may only `get`/`list`/`watch` pods, pods/log and events in granted namespaces (`deploy/k8s/ops-ro.yaml`; no secrets, configmaps or exec), the adapter only sends GET (`src/adapters/k8s.ts`), and tools refuse namespaces outside `OPS_K8S_NAMESPACES` before calling the API and build paths only from zod-validated Kubernetes names. Pod specs hold `env`/`args`, which often carry secrets: tools read `status` plus image and resource limits only, and the `Pod` type in `src/tools/k8s/pods.ts` deliberately omits those fields.

Tools declare the adapters they need (`requires`); `toolsFor` in `src/tools/index.ts` drops tools whose adapter isn't configured, so they are never exposed.

`src/tools/postgres/slow-queries.ts` (`pg_slow_queries`) is the reference tool; copy its shape for new tools. Tool sources are grouped by adapter (`src/tools/postgres/`, `src/tools/k8s/`), one file per tool or close pair, plus a `shared.ts` for helpers they share.

Query text from `pg_stat_activity` is verbatim (unlike `pg_stat_statements`, which normalizes it), so it must go through `stripLiterals` (`src/lib/sql-text.ts`) before it is returned: literals can hold user data or secrets, and comments can carry text aimed at the model. `src/tools/postgres/shared.ts` (`toSession`, used by `pg_activity` and `pg_blocking`) does this.

## Tests

`test/harness.ts` starts a real MCP server and client over `InMemoryTransport`, so tests go through the actual protocol (`listTools`/`callTool`). In tool tests use `const harness = useHarness()` at file level and `const h = await harness({...})` per test; it closes the server after each test. Both transport halves must come from the same SDK package.

Tests are grouped by area in both `test/unit/` and `test/integration/`: `core/` (registry, config, limits, redaction), `postgres/`, `k8s/`; a new adapter gets its own folder in each. Integration tests share container setups: `test/integration/postgres/pg-fixture.ts` (`startPostgres`) and `test/integration/k8s/k8s-fixture.ts` (`startK3s`, which applies `deploy/k8s/ops-ro.yaml` and connects with that ServiceAccount's token, as in production).

Output is redacted per string before serialization (`registry.ts`); redacting the JSON text corrupts it and misses escaped secrets.

Rules for adding a tool:

- a unit test with a fake adapter,
- an integration test against the real service,
- at least one secret planted in its fixture that must not appear in output,
- updating the inline snapshot in `registry.test.ts` ("real v1 tool list"); it exists so surface changes are deliberate.

**Fault lab** (`lab/`): each scenario (`lab/scenarios/<area>/*.ts`, with `security/` for cross-cutting ones like prompt injection) is data: a `rootCause`, planted `secrets`, `break(lab)` that breaks one thing in a fresh k3s + Postgres, and `evidence` (tool calls whose output must show the diagnosis; checks are retried because live state flips). The runner also asserts no planted secret appears in any output and saves the outputs, as the model sees them, to `lab/results/` (gitignored). New scenarios go in the `scenarios` list in `lab/lab.test.ts`.

Planned work and the backlog live in `ROADMAP.md`. Update its status column and backlog in the same branch as the work.

SDK v2 behaviour to know: calling an unknown/hidden tool rejects with a `ProtocolError` (not an `isError` result).
