# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI ops agent for self-hosted infra. v1 is **read-only diagnosis**: an MCP server exposes diagnostic tools to a model. Currently the only package is `packages/mcp-server`, the only code allowed to touch infra.

## Toolchain

- Node 26 (pinned in `.nvmrc`, run `nvm use`); pnpm 12 workspace (`packages/*`), pinned via `packageManager` in the root `package.json`. Use pnpm, not npm.
- `pnpm-workspace.yaml` enforces supply-chain policy: `minimumReleaseAge` (no package versions younger than 7 days) and `allowBuilds` (install scripts denied by default). A new dependency that trips either needs a deliberate entry there, not a workaround.
- MCP SDK is **v2**: `@modelcontextprotocol/server` (runtime) and `@modelcontextprotocol/client` (tests only). Not the legacy `@modelcontextprotocol/sdk` 1.x package. Zod 4.
- ESM with `NodeNext` resolution: relative imports need the `.js` extension.

## Commands

From the repo root (fans out to all packages):

```
pnpm install
pnpm typecheck
pnpm test          # unit tests, no dependencies
pnpm test:int      # integration tests, needs Docker (Testcontainers, postgres:16-alpine)
pnpm build
```

Single test (from `packages/mcp-server`):

```
pnpm exec vitest run test/unit/registry.test.ts
pnpm exec vitest run test/unit -t "hidden tool"
```

Running the server needs `OPS_PG_URL` (connect as the `ops_ro` role); optional `OPS_MAX_LEVEL` (must be 1 in v1, boot fails otherwise) and `OPS_KNOWN_SECRETS` (comma-separated values scrubbed verbatim from output). stdout is the MCP channel, so all logging goes to stderr.

## Architecture

**Tools are plain data.** A tool is a `ToolDef` (`src/types.ts`, built with `defineTool`): name, `Level`, model-facing description, a zod raw shape for input, optional timeout/output limits, and `run(args, ctx)`. Tools never import adapters; they get everything through `ToolContext` (`pg`, `signal`, `log`), so unit tests pass fake clients. `src/tools/index.ts` (`allTools`) is the single source of truth for the exposed surface.

**The registry owns all safety behaviour** (`src/registry.ts`, `registerTools`). Every call goes validate → timeout → serialize → redact → truncate → audit:
- Tools with `level > maxLevel` are never registered (hidden, not just denied).
- Input is `z.object(shape).strict()`: unknown keys are rejected. The handler re-validates even though the SDK also validates.
- Expected failures: tools throw `ToolError(code, message)`; the message is shown to the model (after redaction). Any other error is logged locally and the model only sees `internal_error`, because raw errors can leak hosts/connection strings.
- All output passes through the redactor (`src/lib/redact.ts`): exact known secrets first, then regex patterns that deliberately over-redact.

**Entry point** (`src/index.ts`) uses `serveStdio(factory)`, which creates one `McpServer` per connection and serves both the 2025-era protocol and the 2026-07-28 revision. Tool registration happens inside the factory.

**Postgres access is read-only in three layers:** the `ops_ro` role has only `pg_monitor` (`deploy/sql/ops_ro.sql`), every pooled session is forced read-only with statement/lock timeouts (`src/adapters/pg.ts`), and tools run fixed SQL with bound parameters. User input may select from a whitelist (see `ORDER_BY` in `src/tools/postgres.ts`) but is never interpolated.

`src/tools/postgres.ts` (`pg_slow_queries`) is the reference tool; copy its shape for new tools.

## Tests

`test/harness.ts` starts a real MCP server and client over `InMemoryTransport`, so tests go through the actual protocol (`listTools`/`callTool`). Both transport halves must come from the same SDK package.

Rules for adding a tool:
- a unit test with a fake adapter,
- an integration test against the real service,
- at least one secret planted in its fixture that must not appear in output,
- updating the inline snapshot in `registry.test.ts` ("real v1 tool list"); it exists so surface changes are deliberate.

Planned, not yet present: fault lab (`make lab SCENARIO=…`) and agent evals (`pnpm eval`).

SDK v2 behaviour to know: calling an unknown/hidden tool rejects with a `ProtocolError` (not an `isError` result).
