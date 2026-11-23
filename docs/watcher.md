# Watcher

`packages/watcher` checks the stack on a schedule and starts an agent investigation only when something new is
wrong. A check costs nothing: it calls `ops_triage` on the read-only MCP server, with no model. An investigation
(Claude Haiku 5.5, about $0.002) runs only for a new incident, and its report is written as one JSON line.

## How it works

1. Every `OPS_WATCH_INTERVAL_S` (default 60), call `ops_triage`.
2. Take its problems, and its checks that could not run (`unavailable`: an unreachable database is the incident, not
   a reason to stay quiet); software the stack does not run (`not_installed`, e.g. cert-manager) is no finding.
3. Turn each finding into a fingerprint that ignores what changes between checks (counts, ages, timestamps, pod name
   suffixes), so the same crash loop a minute later is the same problem, not a new alert.
4. All findings new in one check form one incident (a crash loop shows up as a pod, an event and a log line at once)
   and get one investigation. The agent starts with the triage in its first message, so it begins with the evidence.
5. A finding seen again keeps its incident: no new investigation. An incident whose problems have all been gone for
   `OPS_WATCH_RESOLVE_AFTER_CHECKS` checks in a row (default 3) is resolved; if they come back, that is a new incident.

The watcher is an MCP client: it starts the server (`packages/mcp-server`) as a child process over stdio and passes
it only the server's own settings (`OPS_*`), never the model's API key. The server stays the only code that touches
infra, read-only in three layers as before; the watcher changes nothing.

## Budget

- `OPS_WATCH_MAX_PER_HOUR` (default 3) and `OPS_WATCH_MAX_PER_DAY` (default 10) cap investigations. Past a cap, a new
  incident is still recorded (`incident_not_investigated`, with the reason) but no model runs.
- `OPS_WATCH_MAX_COST_USD` (default 0.05) and `OPS_WATCH_MAX_TURNS` (default 12) stop a single investigation.
- A check that fails now and then (one timeout) opens an incident each time it comes back after resolving; the
  hourly cap bounds what that costs. Ignore it if it is known to flap.
- `OPS_WATCH_IGNORE` lists known, accepted problems (comma-separated, case-insensitive substrings of
  `tool: problem`), e.g. `no maxmemory limit`. Without it, a permanent warning costs one investigation per restart:
  the watcher keeps its incidents in memory.

## Configuration

Everything the server needs (`OPS_PG_URL`, `OPS_K8S_NAMESPACES`, `OPS_REDIS_URL`, …, see `CLAUDE.md`), plus:

| Variable                         | Default                     | Meaning                                                    |
| -------------------------------- | --------------------------- | ---------------------------------------------------------- |
| `ANTHROPIC_API_KEY`              | required                    | For investigations only; never passed to the server        |
| `OPS_WATCH_MODEL`                | `claude-haiku-5-5`          | The investigating model                                    |
| `OPS_WATCH_INTERVAL_S`           | `60`                        | Seconds between checks (10 to 3600)                        |
| `OPS_WATCH_RESOLVE_AFTER_CHECKS` | `3`                         | Checks a problem must be gone before its incident resolves |
| `OPS_WATCH_MAX_PER_HOUR`         | `3`                         | Investigations per hour                                    |
| `OPS_WATCH_MAX_PER_DAY`          | `10`                        | Investigations per day                                     |
| `OPS_WATCH_MAX_COST_USD`         | `0.05`                      | Spend limit for one investigation                          |
| `OPS_WATCH_MAX_TURNS`            | `12`                        | Model calls for one investigation                          |
| `OPS_WATCH_IGNORE`               | empty                       | Accepted problems, comma-separated substrings              |
| `OPS_WATCH_REPORT_FILE`          | unset                       | Also append each report to this file (one JSON line each)  |
| `OPS_WATCH_SERVER`               | the server built next to it | Path to the MCP server's `dist/src/index.js`               |

Run it from the repo: `pnpm build`, then `node packages/watcher/dist/src/index.js` with the variables set.

## Reading the reports

Every event is one JSON line on the watcher's stderr, and also in `OPS_WATCH_REPORT_FILE` when that is set. Events:

| `event`                     | When                                        | Extra fields                             |
| --------------------------- | ------------------------------------------- | ---------------------------------------- |
| `incident`                  | a new incident was investigated             | `report`, `outcome`, `cost_usd`, `turns` |
| `incident_not_investigated` | a new incident arrived past a budget cap    | `reason`                                 |
| `investigation_failed`      | the model call failed (e.g. API overloaded) | `error`                                  |
| `incident_resolved`         | the incident's problems are gone            |                                          |
| `check_failed`              | `ops_triage` could not run; nothing changed | `error`                                  |

All carry `at` (time of the check); the incident events also carry `incident` (a number, per watcher run) and
`findings` (the `tool: problem` lines). Reports contain only tool output the server already redacted.

The commands below assume the watcher runs as the Deployment `ops-watcher` in the namespace `ops`, and `jq` is
installed; adjust the names to your setup.

**From the pod's log** (works without a volume; Kubernetes keeps the log of the current and the previous container):

```sh
# Follow new reports as they happen
kubectl -n ops logs deploy/ops-watcher -f | jq -c 'select(.event)'

# The latest investigations, readable
kubectl -n ops logs deploy/ops-watcher --since=24h \
  | jq -r 'select(.event == "incident") | "\(.at) #\(.incident) \(.findings | join("; "))\n\(.report)\n"'

# Before the last restart
kubectl -n ops logs deploy/ops-watcher --previous | jq -c 'select(.event)'
```

Lines that are not JSON (e.g. the server's own startup messages on stderr) are skipped by `select(.event)`; `jq` may
warn about them, which is harmless (`jq -R 'fromjson? | select(.event)'` avoids the warnings).

**From the mounted volume** (survives restarts and log rotation): mount a volume (a PersistentVolumeClaim, or a
`hostPath` on a single node) at, say, `/var/lib/ops-watcher` and set
`OPS_WATCH_REPORT_FILE=/var/lib/ops-watcher/reports.jsonl`.

```sh
# The last 20 events, from the running pod
kubectl -n ops exec deploy/ops-watcher -- tail -n 20 /var/lib/ops-watcher/reports.jsonl | jq .

# Copy the whole file out and read it locally
kubectl -n ops cp "$(kubectl -n ops get pod -l app=ops-watcher -o name | head -1 | cut -d/ -f2)":/var/lib/ops-watcher/reports.jsonl reports.jsonl
jq -r 'select(.event == "incident") | "\(.at) #\(.incident)\n\(.report)\n"' reports.jsonl

# Incidents that were never investigated (budget) or are still open
jq -c 'select(.event == "incident_not_investigated")' reports.jsonl
```

`kubectl exec` and `kubectl cp` need your own admin access; the agent's `ops-ro` ServiceAccount cannot exec.
With a `hostPath` volume you can also read the file on the node directly. Nothing rotates the file yet: at a few
lines per incident it grows slowly, but truncate it now and then (`: > reports.jsonl` inside the pod).

## Tests

Unit tests (`packages/watcher/test/unit`): fingerprints, incident open/resolve, flicker, ignore list, hourly and
daily budgets, the check loop with fake triage and agent, config, the reporter and `serverEnv`. The integration test
(`test/integration/watch.int.test.ts`) builds and starts the real server over stdio against a real Postgres with a
lock wait, runs the real agent loop with a fake model, and checks the report file: one investigation with the
evidence in its first message, then `incident_resolved` once the lock is released.
