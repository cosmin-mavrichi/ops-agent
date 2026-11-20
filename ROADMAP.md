# Roadmap

v1 goal: a read-only agent that diagnoses incidents on the self-hosted stack (API, worker, Postgres, Redis,
Meilisearch, all in Docker behind a Docker socket proxy). One branch per step; merge to `main` when green.

## Steps

| #   | Step                                                                                                                                                                    | Status  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Hardening: pg pool error handler, client cancellation, config tests, real-Postgres timeout test, CI, Biome                                                              | done    |
| 2   | `pg_activity` (connections, live sessions) and `pg_blocking` (lock chains, root blockers)                                                                               | done    |
| 3   | Docker adapter via the socket proxy, filtered by Compose project label: container status/restarts/exit codes, logs                                                      | next    |
| 4   | Fault lab (Compose stack + `make lab SCENARIO=…`): crash-looping worker, lock contention, prompt-injection log line                                                     | planned |
| 5   | Redis, disk, backup freshness, certificate expiry tools + scenarios: Redis maxmemory, disk at 95%, paused worker / queue backlog, stale backup, expiring certificate    | planned |
| 6   | Agent loop + evals (`pnpm eval`): root cause named, only allowed tools, under turn/cost budget, no planted secret in transcript; record redacted tool output for replay | planned |

Write tools (`Level.Change`, `Level.Dangerous`) and approvals are v2; until then the server refuses to boot with
`OPS_MAX_LEVEL > 1`.

## v2: maintaining the infrastructure

Starts only after step 6: the evals must show the agent names the right root cause reliably before it may act on it.

**Prerequisites, before the first write tool:**

- **Approval flow.** The agent proposes an action with its reason ("restart `worker`: crash-looping, exit 137, OOM");
  a human approves or rejects it, in the MCP client or out of band (e.g. Slack). `Level.Change` is approved per
  action; `Level.Dangerous` needs explicit approval every time and is never batched.
- **Separate server, separate credentials.** Write tools live in their own MCP server with their own Postgres role and
  a Docker proxy that allows only the specific endpoints they need. The read-only server stays read-only.
- **Actions only from approved plans.** A write call must trace back to a human-approved proposal, never directly to
  text from tool output. Prompt-injection scenarios in the lab and evals must cover attempts to trigger actions.
- **Per action:** dry run first, then a post-check that the fix worked (e.g. container healthy, blocked sessions
  gone), rate limits, and an audit entry with who approved it.

**Three kinds of maintenance:**

| Kind                       | Examples                                                                                 | How                                      |
| -------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| Incident remediation       | restart a container, end a blocking session, pause/resume the worker, roll back a deploy | `Level.Change` tools, with approval      |
| Routine upkeep             | verify a backup restores, renew certificates, clean up disk, vacuum, patch updates       | scheduled runs, reports, then tools      |
| Configuration changes      | Compose files, Postgres settings, resource limits                                        | agent opens a pull request, no live edit |
| Destructive / irreversible | restore a backup, schema change, major version upgrade                                   | `Level.Dangerous`, approval every time   |

**First write tools,** paired with the diagnosis tools that justify them:

1. `docker_restart` (Level 2), justified by the step 3 container status and logs.
2. `pg_terminate_session` (Level 2), justified by `pg_blocking`; only for sessions it reported, never ops roles.

## Backlog

Smaller items, not tied to a step. Move into a step when picked up.

- **Prompt injection.** Tool output reaches the model as-is. Low risk while v1 is read-only; becomes real with the
  logs tool (step 3). Cover it in the lab (step 4) and evals (step 6).
- **Record tool responses.** Step 6 replay needs the redacted output of each call; the audit entry stores only
  args and outcome today.
- **Server-side query cancellation.** A timed-out query keeps running until `statement_timeout` (5s); with a pool
  of 2, two hung calls can block it for up to 5s. Acceptable for v1.
- **`client_addr` in `pg_activity`.** Internal IPs are returned unredacted; decide whether to keep them.
- **CI hardening.** Pin GitHub Actions to commit SHAs once the repo is on GitHub.
- **Dependency policy cleanup.** Drop the `minimumReleaseAgeExclude` entries for vitest 5.1.1 once it is older than
  7 days.

## Decisions

- **No two-phase commit.** `max_prepared_transactions` stays 0; cross-system consistency uses an outbox (one local
  transaction, then a relay). So `pg_blocking` doesn't need `pg_prepared_xacts` support (they would show as pid 0).
