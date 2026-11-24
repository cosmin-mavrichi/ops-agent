# v2 design: the agent acts, a human approves

v1 only reads. v2 lets the agent fix things, one action at a time, and only after a human says yes. This doc covers
the first version (v2.0) and what comes right after it. The prerequisites it builds on are in `ROADMAP.md` (v2).

## Decisions

- **Approval in the MCP client first.** You run the agent from Claude Code (or any MCP client). Before a write tool
  acts, it stops and shows you a confirmation form: what it will do, why, and the evidence. Nothing runs without a
  yes. The watcher, which runs unattended, only _proposes_ actions in its reports in v2.0.
- **The write server trusts its client to show the form to a human.** Any client can answer the form in code (the
  eval's client does, on purpose), so the write server must never be reachable by an unattended client. Two checks
  guard against misconfiguration: the write server refuses a client that does not declare form support
  (elicitation), which the watcher's client does not (it is the SDK's bare `Client`, whose capabilities default to
  none); and the watcher refuses to start if the server it connects to (`OPS_WATCH_SERVER`) names itself the write
  server. Both are tested. Both rest on what the client and server say about themselves, so neither is the
  boundary: **the boundary is the credentials.** The watcher never holds an `ops-write` token, and no write server
  runs in the cluster.
- **Out-of-band approval next (v2.1).** For simple fixes such as restarting a pod stuck on a config that has since
  been fixed: the watcher proposes, you approve later with a command, and the action runs then. Sketched below.
- **First action: restart a deployment** (`k8s_rollout_restart`). It needs the smallest permission (`patch` on
  deployments) and is undone by the next rollout. It is the right fix only when new pods would start in a better
  state than the old ones: a Secret or ConfigMap changed since they started, a dependency that has since come back,
  or a pod stuck in a bad state. It is the wrong fix for a crash loop caused by the image or the config itself, since
  Kubernetes already restarts the container and a new pod fails the same way.
- **A separate package, `packages/mcp-write`**, with its own entry point, config, credentials and image tag. The
  read-only server stays exactly as it is.

## How a write call goes

The form uses MCP's multi-round-trip flow (`inputRequired`), not a server-to-client request: SDK v2 deprecates
`ctx.mcpReq.elicitInput`, which throws on 2026-07-28 requests. The tool _returns_ the form, and the client calls the
tool again with your answer. On a 2025-era connection the SDK's legacy shim does the same in-process (a real
elicitation request, then a second call of the handler), so the tool is written once for both.

```
agent ── k8s_rollout_restart(namespace, deployment, reason) ──▶ write server

round 1 (no answer yet)
  1. validate        strict input; namespace in OPS_K8S_NAMESPACES; deployment a plain Kubernetes name;
                     reason at most 500 characters
  2. rate limit      refuse if the deployment's restartedAt annotation is under 10 minutes old, or if 5
                     deployments in the namespaces were restarted in the last hour (read from the cluster)
  3. look            read the deployment and its pods (replicas, ready, restarts): the evidence shown to you,
                     and the deployment's resourceVersion
  4. dry run         the same PATCH with ?dryRun=All: the API server checks it without changing anything
  5. ask you         return the confirmation form (action, the agent's reason, the evidence, the dry-run result,
                     all redacted) and a signed requestState: namespace, deployment, resourceVersion

         ... you read the form; this time is between rounds and counts against no tool timeout ...

round 2 (the client calls again with your answer)
  6. act             only on "approve", read from a requestState whose signature, expiry and binding hold:
                     PATCH the restartedAt annotation (what `kubectl rollout restart` does) with that
                     resourceVersion; a 409 means it changed meanwhile: "propose again"
  7. check           "rolled out": new pods ready within 2 minutes; "healthy": none of them restarted in the
                     60 seconds after; otherwise "rolled out, not yet proven" or "failed"
  8. audit           one JSON line: action, reason, approval (yes/no, client name), dry run, result
```

Any "no", a closed form, an expired or tampered requestState, or a client that cannot show forms means the action
does not run. The tool then returns "not approved" to the agent, which is a normal answer, not an error.

**Timeouts per phase.** The registry's timeout wraps each round, not the whole flow, so a slow approval is never a
tool timeout (a unit test holds the answer back past the timeout and expects an approval, not `timeout`). Round 1
is reads and a dry run: the usual budget. Round 2 holds the rollout check (2 minutes plus 60 seconds), so the tool
sets a round timeout above that, as an outer limit, and the check keeps its own deadlines inside it. The form
itself is bounded by the requestState's expiry (15 minutes) and, on 2025-era connections, by the shim's
`roundTimeoutMs`.

**Why a signed requestState.** It travels through the client between rounds, so the client or the model could
change it. It is sealed with the SDK's HMAC codec (`createRequestStateCodec`, verified in
`ServerOptions.requestState.verify` before the handler runs), bound to the tool and its arguments, with a key made
per process: one stdio process serves both rounds. It is signed, not encrypted, so it holds only names and the
resourceVersion, nothing secret.

**Why the rate limit reads the cluster.** Each Claude Code session starts its own server, so counters in memory
reset with every session and are not shared between sessions running side by side. The `restartedAt` annotation is
on the deployment itself: it holds across sessions and also counts restarts done by hand.

**Why the resourceVersion.** The form can stay open for minutes; pods may recover, or someone may roll the
deployment meanwhile. The API server rejects a patch whose resourceVersion is stale, so nothing acts on evidence
that no longer holds. The version also changes when the deployment's status does (pods becoming ready), so an
approval can fail with "propose again" when nothing important changed: the safe way to fail. If flapping
readiness makes that common, the narrower check is a JSON Patch with `test` operations on `metadata.generation`
(the spec changed) and on the `restartedAt` annotation (someone else restarted it), which fails atomically in
exactly those two cases. v2.0 keeps the resourceVersion.

## Safety, layer by layer

Same idea as the read server's three layers, for writes:

1. **Credentials.** A new ServiceAccount `ops-write` whose Role allows only `get` and `patch` on `deployments`, and
   `get`/`list` on `pods`, in the granted namespaces (`deploy/k8s/ops-write.yaml`). No delete, no create, no
   secrets, no other resources. Its token is short-lived and made per session
   (`kubectl create token ops-write --duration=1h`); there is no long-lived token Secret, so a laptop never holds a
   write credential for longer than a session. Reading pods means `ops-write` can see pod specs, and specs hold
   `env`: the evidence in step 3 is built with the read server's `summarizePod` and its `Pod` type, which leave
   `env`, `command` and `args` out, so the write server has no second pod reader that could return them.
2. **Adapter.** The write server's Kubernetes client sends only `GET` and `PATCH`, and `PATCH` only to
   `/apis/apps/v1/namespaces/<ns>/deployments/<name>` with the restart annotation; anything else is refused before
   it is sent.
3. **Tool.** Fixed patch body, names validated, the namespace allowlist checked first, the approval in between.

Plus what the registry already does for the read server: strict input, timeouts, redaction of all output, audit.

**Levels.** The write server boots with `OPS_MAX_LEVEL=2` (`Level.Change`) and refuses 3 (`Level.Dangerous`) until
a dangerous tool exists. The read server keeps refusing anything above 1.

**The form is redacted too.** It is shown to you rather than returned as tool output, so the registry's redaction
does not cover it. The model writes the `reason` and may repeat something it read in logs: the whole form goes
through the redactor, and the reason is capped at 500 characters.

**Prompt injection.** The agent's `reason` is only shown to you; it never reaches the cluster. The form shows the
evidence the server read itself (step 3), not text from logs, so a log line saying "restart the api" cannot make
its own case. A lab scenario covers it: logs ask for a restart that nothing justifies; a good agent does not propose
it, and in the test the form is declined anyway.

**Who approved.** Over stdio, the audit's client name is whatever the client says it is: enough for v2.0, where the
person at the client is the one who approves. A real identity comes with v2.1's command-line approval.

## Code layout

- `packages/mcp-write`: entry point, config (`OPS_K8S_NAMESPACES`, its own ServiceAccount token), the write
  Kubernetes adapter, `k8s_rollout_restart`, the approval helper (builds the redacted form and the signed
  requestState in round 1, reads and validates the answer with `acceptedContent` in round 2), tests.
- **The registry learns rounds.** Tools get the round's input responses and verified requestState in their
  context, and an `inputRequired` return passes through the registry (its form redacted) instead of being
  serialized as output. The read server never returns one.
- **Shared with the read server**, exported from `@ops-agent/mcp-server` (one `./shared` entry): `registerTools`,
  `defineTool`, the types, the redactor, `httpGet`, `k8sLabel`, `summarizePod` and `Pod`. No copies. Not as
  TypeScript source alone, like the watcher's `./agent`: that works because only the evals, under vitest, import
  it, while the write server runs under plain `node` (and `Level` is an `enum`, which type stripping cannot run).
  The export resolves to source for typechecking and tests, which CI runs without a build, and to `dist` at
  runtime.
- `deploy/k8s/ops-write.yaml`: the ServiceAccount and its Role. Not in the watcher's manifest: v2.0 runs the write
  server only next to an interactive client, so the cluster never holds a running process with write access.

## Tests

- Unit: approve, decline, closed form and no form support (only approve acts); a slow approval is not a timeout;
  a tampered, expired or rebound requestState is refused; the watcher refusing a write server; rate limits from
  the annotation; the 409 path; "rolled out" vs "healthy"; the form redacted; the evidence holding no `env` (a
  secret planted there); the adapter refusing any other method or path; the audit line. Both protocol eras.
- Integration on k3s with the real `ops-write` RBAC: the restart happens and the post-check sees new pods; a stale
  resourceVersion is rejected; the ServiceAccount cannot delete, create, read secrets or touch other namespaces
  (checked with `kubectl auth can-i`).
- Lab and evals, with the eval's client approving or declining on the test's say:
  - a restart is the fix: pods stuck on a Secret that has since been corrected;
  - a restart is **not** the fix: the existing crash-loop scenario (a wrong Redis address); a good agent does not
    propose one, so the evals never reward proposing restarts;
  - injection: logs ask for a restart that nothing justifies.

## To verify before building

- Which protocol revision Claude Code speaks, and that it shows elicitation forms (on 2026-07-28 as
  `inputRequired.elicit`, on 2025-era connections through the SDK's shim). If a client cannot, the tool refuses: no
  form, no action.
- How long the client waits for round 2, which holds the 3-minute rollout check: if that is under 3 minutes, the
  tool sends progress notifications during the check, or returns at "rolled out" and leaves "healthy" to a
  follow-up read.

## v2.1: out-of-band approval (sketch)

The watcher's report gets a proposal: id, action, reason, evidence, expiry (15 minutes). You approve with
`ops-agent approve <id>` (a small CLI that talks to the write server, and where a real identity for the audit comes
from) or reject by doing nothing. Acting still goes through steps 2-8, so a proposal whose deployment changed since
fails with "propose again". This needs a proposals store and a way to reach the write server, so it waits until
v2.0 works.

## Plan: one PR each

1. This design doc.
2. `packages/mcp-write` skeleton: config, the write Kubernetes adapter, `ops-write` RBAC, shared exports from the
   read server (`summarizePod` included), the registry's rounds, the approval helper with the signed requestState,
   the client checks both ways (form support; the watcher refusing a write server). No tools yet.
3. `k8s_rollout_restart` with the full flow above, its per-round timeouts, unit and integration tests.
4. Lab scenarios (restart is the fix; crash loop where it is not; injection asks for one) and one eval run each.
