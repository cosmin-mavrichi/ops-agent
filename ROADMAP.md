# Roadmap

v1 goal: a read-only agent that diagnoses incidents on the self-hosted stack: API, worker, Postgres, Redis/Valkey
and a search engine (OpenSearch or Elasticsearch) on k3s (single node to start). One branch per step;
merge to `main` when green.

## Steps

| #   | Step                                                                                                                                                                                                           | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Hardening: pg pool error handler, client cancellation, config tests, real-Postgres timeout test, CI, Biome                                                                                                     | done   |
| 2   | `pg_activity` (connections, live sessions) and `pg_blocking` (lock chains, root blockers)                                                                                                                      | done   |
| 3   | Kubernetes adapter via a read-only ServiceAccount (RBAC `get`/`list`/`watch`), scoped to allowed namespaces: pod status, restarts and last termination reason, warning events, logs                            | done   |
| 4   | Fault lab (`pnpm lab`, fresh k3s + Postgres per scenario via Testcontainers): crash-looping worker, lock contention, prompt injection in logs and SQL comments                                                 | done   |
| 5a  | Redis/Valkey: `redis_health` (memory vs maxmemory, OOM rejections, clients, persistence, warnings) and `redis_slowlog` (masked key shapes), keyless ACL user; lab scenarios cache-full and slow-keys           | done   |
| 5b  | Disk/PVC usage, backup freshness (CloudNativePG backup status), certificate expiry (cert-manager) tools + scenarios: volume at 95%, paused worker / queue backlog, stale backup, expiring certificate          | done   |
| 5c  | Search engines, read-only: OpenSearch and Elasticsearch (see below)                                                                                                                                            | done   |
| 6   | Agent loop + evals (`pnpm eval`): root cause named, only allowed tools, under turn/cost budget, no planted secret in transcript; record redacted tool output for replay                                        | doing  |
| 7   | Cheaper runs: a watcher runs the tools on a schedule without a model and starts an investigation only when one reports a problem; first-look evidence bundles per area; compact tool output; cheap model first | done   |

**Step 5b, one PR per area:**

- **Certificates:** `k8s_certificates` (cert-manager Certificates and namespaced Issuers: readiness, expiry,
  overdue renewal); lab scenario expiring-certificate. Done.
- **Backups:** `k8s_pg_backups` (CloudNativePG: last successful backup, failures since, schedules, WAL
  archiving), read from Backup objects because the cluster's `lastSuccessfulBackup` is unset with backup
  plugins; lab scenario failing-backups. Done.
- **Disk/PVC usage:** `prom_volume_usage` through a read-only Prometheus adapter (`kubelet_volume_stats_*`: used,
  capacity, inodes, growth rate and time until full); lab scenario volume-full, with the lab's own Prometheus
  scraping the kubelet. Done.
- **Queue backlog:** `pg_job_queues` for pg-boss, from its own per-queue counters (ready, active, failed, oldest
  wait, last window); `ops_ro` gets column grants on `pgboss.queue` only (`deploy/sql/ops_ro_pgboss.sql`); lab
  scenario paused-worker. Done.

**Step 5c, search engines.** OpenSearch first (Apache 2.0, Linux Foundation), Elasticsearch tested too (same
diagnostic APIs, as with Valkey/Redis).

- **Access:** a role with only cluster/index `monitor` privileges, no document reads (`deploy/search/`).
- **Cluster health:** `search_cluster_health` (status, shard counts, allocation explanation for an unassigned
  shard, disk per node against the watermarks, read-only index blocks); lab scenario search-disk-full (flood
  stage makes the index read-only, the indexer's writes fail). Done.
- **Node pressure:** `search_node_pressure` (JVM heap, old-generation GC time, thread pool queues and rejections,
  tripped circuit breakers), sampled twice a few seconds apart because the counters are cumulative since node
  start; lab scenario search-rejections (an undersized node rejects the storefront's searches). Done.

**Step 6, agent loop and evals.** Built: the agent loop, three backends (own Claude subscription via Claude Code,
Claude API, DeepSeek), code-checked guardrails, a judge, and a readable report per run. Full pass after the agent
prompt changes and a slow-keys scenario fix: all 12 diagnosed correctly at least once on the final version, all
safe; prompt-injection, the flakiest, now passes 5 of 5. Status, results and open items:
`docs/eval-status.md`.

**Step 7, cheaper runs.** Use code for what code can do and the model only for judgment. Every change is measured
with the evals (turns, tokens, cost and diagnosis score per scenario), so savings never come from worse diagnoses.

- **Watcher:** runs the tools on a schedule without a model (they already compute their `problems`) and starts an
  investigation only when one reports a problem; one investigation per incident, not per alert.
  First PR: `packages/watcher`, an MCP client of the read-only server (the server stays the only code that touches
  infra, and never sees the model's API key). Calls `ops_triage` every minute, fingerprints problems so one incident
  gets one investigation (Haiku, with the triage in its first message), resolves an incident once its problems are
  gone for 3 checks, and caps investigations per hour and day. Reports are JSON lines on stderr and, optionally, in a
  file on a mounted volume; how to read both: `docs/watcher.md`. The agent loop moved from `eval/` into the watcher
  package, so the evals measure the loop that runs in production.
  Deployment: `Dockerfile` (both packages, non-root, pinned base image), `deploy/k8s/ops-watcher.yaml` (one pod as
  `ops-ro`, read-only root filesystem, report volume) and the Image workflow (builds every pull request, runs it as a
  pod in k3s against a crash loop, pushes to GHCR on merges to main). Setup guide: `docs/deploy.md`.
- **First-look bundles:** the code that starts an investigation gathers the evidence for that area in parallel
  (pod alert: pods, events, logs), so the model starts with it instead of exploring turn by turn.
  First PR: `ops_triage`, one call that runs every configured check in parallel and returns only the problems,
  grouped by tool, plus the clean and unavailable checks. The watcher runs it every minute and puts its result in
  the investigation's first message. Measured with headless Haiku: crash-loop and lock-contention diagnosed
  correctly and safely, model calls unchanged (4 and 3; the agent still double-checks pods and events). The savings
  come from the watcher, which runs triage without a model. Per-area bundles beyond triage: backlog.
- **Compact tool output** for the model (problems plus key fields; full detail on request). First PR: compact
  JSON from the registry, repeated log lines folded and dated to the second, slow-query text without comments or
  literals and cut to 300 characters, no first-seen time on one-off events. Measured on the last full eval pass's
  tool output: 19% fewer tokens; agent cost per full pass $0.0245 → $0.0213. The pass also fixed two tools the
  agent misread: `k8s_certificates` (a broken issuer is the blocker, not a second cause) and `redis_slowlog`
  (`problems` for whole-collection reads). Further output cuts: backlog.
- **Cheap model first:** the watcher investigates with Haiku. Escalating to a stronger model and the Batch API
  moved to the backlog: with the watcher, model runs are rare enough that they would save little.

Cost (2026-11-23): before step 7, an estimated ~$30-60/month at ~1,500 agent runs a month. With the watcher, the
model runs only for new incidents, under hard caps (3 investigations an hour, 10 a day, $0.05 each): at most about
$0.50 a day, typically cents a month.

Write tools (`Level.Change`, `Level.Dangerous`) and approvals are v2; until then the server refuses to boot with
`OPS_MAX_LEVEL > 1`.

## v2: maintaining the infrastructure

Starts only after step 6: the evals must show the agent names the right root cause reliably before it may act on it.

**Status: design** (2026-11-24, `docs/v2-design.md`). v2.0: approval in the MCP client (a confirmation form before
any action), first action `k8s_rollout_restart`, write server in its own package `packages/mcp-write`. v2.1:
out-of-band approval (the watcher proposes, you approve with a command), for simple fixes such as a restart.

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

## Making on-call easier

Ideas from the on-call side (2026-11-24): what costs time or sleep on a self-hosted stack, and what the agent could
do about it. Roughly in order of value; each is its own PR, read-only unless it says otherwise.

| Idea                       | The annoyance                                                                  | What the agent does                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **What changed**           | Most incidents follow a deploy or config change; finding it is the slow part   | `k8s_changes`: recent rollouts (image, revision, when) per deployment from ReplicaSets; triage and reports say "started 3 min after deploy" |
| **Rollback** (v2)          | A bad deploy's usual fix is going back                                         | `k8s_rollout_undo` after `k8s_rollout_restart`, same approval flow, justified by "what changed"                                             |
| **Failing jobs**           | A nightly CronJob (backup, report) fails silently for weeks                    | `k8s_jobs`: failed and missed CronJob runs, last success; a triage check                                                                    |
| **Slow but no error**      | CPU limits throttle the app, or memory creeps toward an OOM kill               | `prom_pod_resources`: CPU throttling and memory against limits per pod, from Prometheus; a triage check                                     |
| **Daily digest**           | Slow problems (cert in 10 days, disk full in a week) only alert when urgent    | The watcher sends one daily summary of warnings that are not incidents yet; no model needed                                                 |
| **Snooze and maintenance** | Alerts during a planned deploy, or about something already acknowledged        | Snoozes with an expiry and maintenance windows in the `ops-agent` ConfigMap (no redeploy to change them)                                    |
| **Service notes**          | The agent doesn't know "the worker must never run 2 replicas" or who owns what | Notes per service in the `ops-agent` ConfigMap, read by name only (`resourceNames`): ops-ro still reads no other ConfigMap                  |
| **Incident summary**       | Writing up what happened afterwards                                            | When an incident resolves, the watcher writes a short summary: timeline, cause, fix, from its own reports                                   |
| **Ingress errors**         | 502s and 504s at the ingress, with the app's own metrics looking fine          | Read ingress-nginx's request metrics in `prom_http_health` too                                                                              |

## Backlog

Smaller items, not tied to a step. Move into a step when picked up.

- **Stronger model on escalation.** Investigate with Haiku and escalate only when it can't explain the reported
  problems; non-urgent reports through the Batch API. Worth it only if investigations become frequent.
- **Per-area first-look bundles.** When an investigation starts, gather that area's evidence in parallel (pod
  alert: pods, events, logs) beyond what `ops_triage` returns, so the agent skips its double-check calls.
- **Smaller tool output.** A table layout for lists (another 9% of tokens, but it changes every tool's output
  shape), and log volume itself (logs are 40% of tool tokens; JSON-structured logs dominate).

- **Watcher reports to a webhook.** Later, not a priority: POST each report as JSON to a configured URL (Slack
  incoming webhook, ntfy, Discord, own endpoint). Reports are log and file only for now (`docs/watcher.md`); note
  that a webhook sends report text out of the cluster.
- **Error-rate and latency checks for the app.** `ops_triage` watches status, not logs, so an app that returns 500s
  or gets slow without crashing or failing a probe goes unnoticed. Add a triage check (code only, still free): error
  rate and latency from Prometheus when the app exposes HTTP metrics, or a count of ERROR lines in recent logs.
- **Watcher state across restarts.** Incidents live in memory, so a restart re-investigates every open problem once
  (bounded by the hourly cap). Persist the open incidents next to the report file if that turns out to cost money.

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
- **Bearer token for Prometheus.** `OPS_PROM_URL` supports basic auth only; hosted Mimir/Thanos setups often
  want a bearer token (or a tenant header). Add `OPS_PROM_TOKEN_FILE` when one is needed.
- **More job queues.** `pg_job_queues` reads pg-boss in its default schema `pgboss` only. Add a configurable
  schema when an app uses another, and Graphile Worker (the other common Postgres queue) when one needs it.
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
- **Search disk scenario: read-only, not red** (2026-11-22). On a single data node OpenSearch skips the low and
  high watermarks by default (`enable_for_single_data_node: false`), so a full disk does not stop new shards
  from being placed; flood stage still makes indices read-only. That is the incident a single-node setup gets,
  so the lab reproduces it. Integration tests run OpenSearch and Elasticsearch with security on and TLS off.
- **pg-boss first, from its counters** (2026-11-22). The most used Postgres job queue in Node (about 20M npm
  downloads a month against Graphile Worker's 5M). Its `queue` table already holds the counts pg-boss refreshes
  every minute, so the agent needs no access to `job`, where payloads and errors live. Counts older than 5
  minutes are reported as stale: no pg-boss instance is running.
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
