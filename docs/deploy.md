# Deploying the ops agent

One pod in an `ops` namespace watches your application: every minute it checks your pods, events, Postgres,
Redis/Valkey and (optionally) certificates, backups, disk and OpenSearch, with code only. When something new goes
wrong, a short AI investigation (Claude Haiku) writes down the root cause, the fix and where to look. It never changes
anything: every credential it gets is read-only. How the watcher decides and how to read its reports:
[`docs/watcher.md`](watcher.md).

```
namespace ops
└─ Deployment ops-watcher (1 pod, image ghcr.io/cosmin-mavrichi/ops-agent)
   ├─ watcher ── every minute: ops_triage ── new incident? → investigation → report (log + volume)
   └─ MCP server (child process) ── read-only: Kubernetes API, Postgres, Valkey, [Prometheus, OpenSearch]
```

## What you need

- A k3s (or any Kubernetes) cluster and `kubectl` with admin access.
- An Anthropic API key (pay as you go). Set a monthly spend limit on it in the Anthropic Console; the watcher's own
  caps keep it to cents a month in normal use and at most about $0.50 a day (see [Costs](#costs)).
- Admin access to your Postgres and Valkey, once, to create the read-only users.

The examples assume your application runs in the namespace `app`; change it where noted.

## 1. Read-only Postgres role

As the database owner or a superuser, in your application's database (Postgres needs
`shared_preload_libraries = 'pg_stat_statements'`; CloudNativePG: `postgresql.shared_preload_libraries` in the
Cluster spec):

```sh
psql "$ADMIN_URL" -v ops_password="'<a new password>'" -v app_db=app -f deploy/sql/ops_ro.sql
# Only if the app uses pg-boss:
psql "$ADMIN_URL" -f deploy/sql/ops_ro_pgboss.sql
# Only if the app migrates with Prisma, knex or Kysely, after its first migration (rerun if you adopt one later):
psql "$ADMIN_URL" -f deploy/sql/ops_ro_migrations.sql
# The CREATE ROLE statement, password included, is now in pg_stat_statements (the agent redacts it, but there is no
# reason to keep it):
psql "$ADMIN_URL" -c "SELECT pg_stat_statements_reset();"
```

With CloudNativePG, `kubectl cnpg psql <cluster> -n app` gives you a superuser shell; feed it the same files.

## 2. Read-only Valkey/Redis user

```sh
redis-cli -a "$ADMIN_PASSWORD" ACL SETUSER ops_ro reset on ">$OPS_REDIS_PASSWORD" $(grep -v '^#' deploy/redis/ops-ro.acl)
```

Make it survive restarts the way your Valkey keeps its users (`ACL SAVE` with an `aclfile`, or your chart's users
setting). Skip this step if you don't run Valkey or Redis.

## 3. Read-only Kubernetes access

`deploy/k8s/ops-ro.yaml` creates the `ops` namespace and the `ops-ro` ServiceAccount, allowed to read pods, logs,
events, ReplicaSets and Jobs (for what changed), cert-manager certificates and CloudNativePG backups in `app` only (no
secrets, no exec, no writes). For other namespaces, copy its Role and RoleBinding per namespace. When upgrading, apply
this file before the new image: a check the role does not allow yet shows in `ops_triage` as unavailable, which the
watcher treats as a possible incident.

```sh
kubectl apply -f deploy/k8s/ops-ro.yaml
```

## 4. Settings and keys

One Secret holds everything; hostnames are your services' in-cluster names:

```sh
kubectl -n ops create secret generic ops-watcher \
  --from-literal=OPS_PG_URL='postgres://ops_ro:<password>@app-db-rw.app.svc:5432/app' \
  --from-literal=OPS_REDIS_URL='redis://ops_ro:<password>@valkey.app.svc:6379' \
  --from-literal=ANTHROPIC_API_KEY='sk-ant-…'
```

Optional entries (all settings: [`docs/watcher.md`](watcher.md#configuration) and the README):

- `OPS_PROM_URL='http://prometheus.monitoring.svc:9090'`: volume usage and time until full, and each app's error
  rate and latency when it exposes a request duration histogram (`http_server_request_duration_seconds` from
  OpenTelemetry, or `http_request_duration_seconds` from prom-client). Thresholds: `OPS_HTTP_*` in the README;
  under them, an app much worse than over the previous day is flagged too.
- `OPS_SEARCH_URL='http://ops_ro:<password>@opensearch.app.svc:9200'`: OpenSearch, with the role from
  `deploy/search/`.
- `OPS_WATCH_IGNORE='no maxmemory limit'`: problems you have accepted, so they never cost an investigation.
- `OPS_KNOWN_SECRETS`: your app's own secrets, comma-separated, so a log line leaking one is reported as a leak.

To change a setting later: `kubectl -n ops create secret generic ops-watcher … --dry-run=client -o yaml | kubectl
apply -f -`, then `kubectl -n ops rollout restart deploy/ops-watcher`.

## 5. The watcher

If your application is not in `app`, edit `OPS_K8S_NAMESPACES` in `deploy/k8s/ops-watcher.yaml` (it must match the
namespaces granted in step 3). Then:

```sh
kubectl apply -f deploy/k8s/ops-watcher.yaml
kubectl -n ops rollout status deploy/ops-watcher
kubectl -n ops logs deploy/ops-watcher
```

The log starts with the server's `ready` line and the list of tools it exposes: a tool missing there means its
setting is missing (e.g. no `redis_*` tools without `OPS_REDIS_URL`). From then on, every incident is one JSON line;
reading them: [`docs/watcher.md`](watcher.md#reading-the-reports).

The image is public, so the cluster pulls it without credentials. (Maintainers: GitHub makes a new package private;
after the first image is pushed, set it to public once under the package's settings.)

## Upgrading

The manifest uses the `:main` tag, which follows every merge: `kubectl -n ops rollout restart deploy/ops-watcher`
pulls the latest. To stay on one version, set the image to a `:sha-<commit>` tag and `imagePullPolicy: IfNotPresent`.
Open incidents are kept in memory, so after a restart each open problem is investigated once more (bounded by the
hourly cap).

## Removing it

```sh
kubectl delete -f deploy/k8s/ops-watcher.yaml       # also deletes the report volume
kubectl -n ops delete secret ops-watcher
kubectl delete -f deploy/k8s/ops-ro.yaml
psql "$ADMIN_URL" -c "DROP OWNED BY ops_ro; DROP ROLE ops_ro;"
redis-cli -a "$ADMIN_PASSWORD" ACL DELUSER ops_ro
```

## Costs

| Part                      | Cost                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| Checks every minute       | No model: about 100-150 MB of memory and a few small read-only queries a minute |
| One investigation (Haiku) | About $0.001-0.003                                                              |
| Ceiling with the defaults | 10 investigations a day at most $0.05 each: about $0.50 a day                   |
| Typical                   | A few incidents a week: cents a month                                           |
| Image                     | Free: public image on GitHub's registry                                         |

## How this is tested

`packages/mcp-server/test/integration/k8s/deploy.int.test.ts` applies both manifests to a real k3s and checks the pod
runs as `ops-ro`, unprivileged, with its settings and volume. `deploy-image.int.test.ts` runs the image built from
the Dockerfile as a pod with the Secret from step 4, makes a pod crash-loop and reads the incident from the report
file with `kubectl exec`; the Image workflow runs it on every pull request. Locally:

```sh
docker build -t ops-agent:dev .
cd packages/mcp-server && OPS_E2E_IMAGE=ops-agent:dev pnpm exec vitest run test/integration/k8s/deploy-image
```
