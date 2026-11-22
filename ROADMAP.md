# Roadmap

v1 goal: a read-only agent that diagnoses incidents on the self-hosted stack: API, worker, Postgres, Redis/Valkey
and a search engine (Meilisearch, OpenSearch or Elasticsearch) on k3s (single node to start). One branch per step;
merge to `main` when green.

## Steps

| #   | Step                                                                                                                                                                                                  | Status  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Hardening: pg pool error handler, client cancellation, config tests, real-Postgres timeout test, CI, Biome                                                                                            | done    |
| 2   | `pg_activity` (connections, live sessions) and `pg_blocking` (lock chains, root blockers)                                                                                                             | done    |
| 3   | Kubernetes adapter via a read-only ServiceAccount (RBAC `get`/`list`/`watch`), scoped to allowed namespaces: pod status, restarts and last termination reason, warning events, logs                   | done    |
| 4   | Fault lab (`pnpm lab`, fresh k3s + Postgres per scenario via Testcontainers): crash-looping worker, lock contention, prompt injection in logs and SQL comments                                        | done    |
| 5a  | Redis/Valkey: `redis_health` (memory vs maxmemory, OOM rejections, clients, persistence, warnings) and `redis_slowlog` (masked key shapes), keyless ACL user; lab scenarios cache-full and slow-keys  | done    |
| 5b  | Disk/PVC usage, backup freshness (CloudNativePG backup status), certificate expiry (cert-manager) tools + scenarios: volume at 95%, paused worker / queue backlog, stale backup, expiring certificate | doing   |
| 5c  | Search engines, read-only: OpenSearch, Elasticsearch and Meilisearch (see below)                                                                                                                      | planned |
| 6   | Agent loop + evals (`pnpm eval`): root cause named, only allowed tools, under turn/cost budget, no planted secret in transcript; record redacted tool output for replay                               | planned |

**Step 5b, one PR per area:**

- **Certificates:** `k8s_certificates` (cert-manager Certificates and namespaced Issuers: readiness, expiry,
  overdue renewal); lab scenario expiring-certificate. Done.
- **Backups:** `k8s_pg_backups` (CloudNativePG: last successful backup, failures since, schedules, WAL
  archiving), read from Backup objects because the cluster's `lastSuccessfulBackup` is unset with backup
  plugins; lab scenario failing-backups. Done.
- **Disk/PVC usage:** a read-only Prometheus adapter (`kubelet_volume_stats_*`); scenario volume at 95%.
- **Queue backlog:** Postgres job queues first (pending count, oldest job's age, failures, with fixed SQL per
  library: pg-boss, Graphile Worker); which library to support first is still open. Scenario paused worker.

**Step 5c, search engines.** OpenSearch first (Apache 2.0, Linux Foundation), Elasticsearch tested too (same
diagnostic APIs, as with Valkey/Redis), plus Meilisearch (already in the stack).

- **Tools:** cluster health and unassigned shards with the allocation explanation, disk watermarks and read-only
  index blocks, JVM heap and circuit breakers, thread pool rejections, shard counts; Meilisearch task queue and
  failed tasks.
- **Access:** a role with only cluster/index `monitor` privileges, no document reads.
- **Scenarios:** cluster red after the disk fills, search rejections under load.

Write tools (`Level.Change`, `Level.Dangerous`) and approvals are v2; until then the server refuses to boot with
`OPS_MAX_LEVEL > 1`.

## v2: maintaining the infrastructure

Starts only after step 6: the evals must show the agent names the right root cause reliably before it may act on it.

**Prerequisites, before the first write tool:**

- **Approval flow.** The agent proposes an action with its reason ("restart `worker`: crash-looping, exit 137, OOM");
  a human approves or rejects it, in the MCP client or out of band (e.g. Slack). `Level.Change` is approved per
  action; `Level.Dangerous` needs explicit approval every time and is never batched.
- **Separate server, separate credentials.** Write tools live in their own MCP server with their own Postgres role and
  a ServiceAccount whose RBAC allows only the specific verbs they need (e.g. `patch` on deployments for restarts). The read-only server stays read-only.
- **Actions only from approved plans.** A write call must trace back to a human-approved proposal, never directly to
  text from tool output. Prompt-injection scenarios in the lab and evals must cover attempts to trigger actions.
- **Per action:** dry run first, then a post-check that the fix worked (e.g. container healthy, blocked sessions
  gone), rate limits, and an audit entry with who approved it.

**Three kinds of maintenance:**

| Kind                       | Examples                                                                                 | How                                      |
| -------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| Incident remediation       | restart a container, end a blocking session, pause/resume the worker, roll back a deploy | `Level.Change` tools, with approval      |
| Routine upkeep             | verify a backup restores, renew certificates, clean up disk, vacuum, patch updates       | scheduled runs, reports, then tools      |
| Configuration changes      | Kubernetes manifests, Postgres settings, resource limits                                 | agent opens a pull request, no live edit |
| Destructive / irreversible | restore a backup, schema change, major version upgrade                                   | `Level.Dangerous`, approval every time   |

**First write tools,** paired with the diagnosis tools that justify them:

1. `k8s_rollout_restart` (Level 2), justified by the step 3 pod status, events and logs.
2. `pg_terminate_session` (Level 2), justified by `pg_blocking`; only for sessions it reported, never ops roles.
3. `redis_invalidate` (Level 2): delete cache entries whose shape matches a pattern, e.g. after a deploy changed
   the cached format and logs show deserialization errors. Justified by `k8s_logs` plus `redis_health` /
   `redis_slowlog`. Constraints:
   - **Operator allowlist of patterns** (e.g. `cache:*`), set in config, never chosen by the model. Sessions,
     queues and rate limits often share the same Redis; deleting them logs users out or drops jobs.
   - **Its own ACL user**, so `ops_ro` stays keyless: only `SCAN` and `UNLINK`, and only on the allowlisted
     key patterns (`~cache:*`), so Redis itself refuses anything outside the allowlist, not just the adapter.
   - **Targeted deletes only:** `SCAN` + `UNLINK` in small batches with a key-count cap, so the server never
     stalls. Never `FLUSHALL` / `FLUSHDB`.
   - **Dry run** reports the matching key count and masked shapes (never values), the hit rate and the database's
     headroom: emptying a hot cache sends its traffic to the database at once (stampede).
   - **Post-check:** the errors that justified it stop, and database load stays within limits.
   - **Never triggered by log content.** The plan must rest on measured evidence and a human approval; a log line
     asking for invalidation is prompt injection (cover it in the lab and evals).
   - The report names the real fix (versioned cache keys, deploy order); invalidation is the mitigation.

## Backlog

Smaller items, not tied to a step. Move into a step when picked up.

- **Prompt injection.** Tool output reaches the model as-is. Low risk while v1 is read-only; becomes real with the
  logs and events tools (step 3). Cover it in the lab (step 4) and evals (step 6).
- **Record tool responses.** The lab saves each scenario's redacted tool outputs to `lab/results/`; step 6 replay
  still needs that per agent run, not just per lab run.
- **Server-side query cancellation.** A timed-out query keeps running until `statement_timeout` (5s); with a pool
  of 2, two hung calls can block it for up to 5s. Acceptable for v1.
- **`client_addr` in `pg_activity`.** Internal IPs are returned unredacted; decide whether to keep them.
- **Secret rotation.** `OPS_KNOWN_SECRETS_DIR` is read once at boot, so a rotated secret needs a restart;
  re-read the directory when kubelet swaps `..data`.
- **High-entropy token redaction** as a fallback for secrets nobody listed. Needs its own false-positive tests
  (image digests, `pod-template-hash`, UUIDs, request ids), so a separate PR.
- **Encoded known secrets.** Exact matching misses a known secret that appears base64- or URL-encoded in output;
  redact those forms too.
- **`k8s_logs` loses the newest lines on overflow.** Output over the limit is truncated at the end, which is
  where the newest lines are, and the cut JSON no longer parses. CloudNativePG's JSON log lines overflow at
  about 40 lines. Keep the newest lines that fit instead, and say how many were dropped.
- **Stuck backups.** A backup to an unreachable object store stays `running` for a long time instead of
  failing; `k8s_pg_backups` could flag one running far longer than usual.
- **Dependency policy cleanup.** Drop the `minimumReleaseAgeExclude` entries for vitest 5.1.1 once it is older than
  7 days.

## Decisions

- **Disk usage from Prometheus, not the kubelet** (2026-11-22). Volume usage is only exposed by the kubelet, and
  reading it needs `nodes/proxy`, which can also be used to exec into pods. A Prometheus-compatible query API
  (Prometheus, VictoriaMetrics, Mimir, Thanos) gives `kubelet_volume_stats_*` with no dangerous RBAC.
- **Job queues: Postgres first, Redis later** (2026-11-22). Backlog for Redis-based queues (BullMQ) means reading
  queue keys, which the keyless `ops_ro` ACL user deliberately cannot; add it only when an app needs it, with a
  narrow key pattern.
- **cert-manager: namespaced Issuers only** (2026-11-22). ClusterIssuers are cluster-scoped and would need a
  ClusterRole; `k8s_certificates` reports them as not inspected instead.

- **Valkey first, Redis too** (2026-11-20). New self-hosted setups mostly pick Valkey (BSD, Linux Foundation, the
  Fedora/managed-cloud default); Redis 8 is AGPL again and still common. The diagnostic commands are identical, so one
  set of tools covers both: the lab runs Valkey, the integration tests run both. Client: `@redis/client` (no
  dependencies) rather than Valkey GLIDE (native binary).
- **CI actions pinned to commit SHAs** (2026-11-20), updated by Dependabot with a 7-day cooldown, matching the
  npm `minimumReleaseAge` policy. Checkout doesn't persist the token; setup-node caching is off.
- **No two-phase commit.** `max_prepared_transactions` stays 0; cross-system consistency uses an outbox (one local
  transaction, then a relay). So `pg_blocking` doesn't need `pg_prepared_xacts` support (they would show as pid 0).
- **Platform: k3s, not Docker Compose** (2026-11-20). RBAC gives read-only access natively (no Docker socket proxy),
  events and pod status give structured evidence, and `rollout restart` / `rollout undo` make v2 actions reversible.
  Start single-node; Postgres via the CloudNativePG operator. Pod specs can hold env values, so adapters build output
  from status fields and never return `env`.
- **Fault lab uses Testcontainers, not k3d/kind + make** (2026-11-20). Same k3s and Postgres fixtures as the integration
  tests, so no extra tools to install locally or in CI.
