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
