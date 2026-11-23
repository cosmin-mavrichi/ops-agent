# v2 design: the agent acts, a human approves

v1 only reads. v2 lets the agent fix things, one action at a time, and only after a human says yes. This doc covers
the first version (v2.0) and what comes right after it. The prerequisites it builds on are in `ROADMAP.md` (v2).

## Decisions

- **Approval in the MCP client first.** You run the agent from Claude Code (or any MCP client). Before a write tool
  acts, it stops and shows you a confirmation form: what it will do, why, and the evidence. Nothing runs without a
  yes. The watcher, which runs unattended, only *proposes* actions in its reports in v2.0.
- **Out-of-band approval next (v2.1).** For simple fixes such as restarting a stuck pod: the watcher proposes, you
  approve later with a command or a link, and the action runs then. Sketched below; built after v2.0 works.
- **First action: restart a deployment** (`k8s_rollout_restart`). The most common fix (crash loop, stuck pod),
  undone by the next rollout, and it needs the smallest permission (`patch` on deployments).
- **A separate package, `packages/mcp-write`**, with its own entry point, config, credentials and image tag. The
  read-only server stays exactly as it is.

## How a write call goes

```
agent ── k8s_rollout_restart(namespace, deployment, reason) ──▶ write server
  1. validate        strict input; namespace in OPS_K8S_NAMESPACES; deployment name a plain Kubernetes name
  2. rate limit      at most one restart per deployment per 10 minutes, 5 restarts an hour overall
  3. look            read the deployment (replicas, ready, restarts of its pods): the evidence shown to you
  4. dry run         the same PATCH with ?dryRun=All: the API server checks it without changing anything
  5. ask you         confirmation form: action, the agent's reason, the evidence, the dry-run result
  6. act             only on "approve": PATCH spec.template annotations (what `kubectl rollout restart` does)
  7. check           wait until the rollout is done (new pods ready) or 2 minutes pass; report which
  8. audit           one JSON line: action, reason, approval (yes/no, client name), dry run, result
```

Any "no", a closed form, a timeout or a client that cannot show forms means the action does not run. The tool then
returns "not approved" to the agent, which is a normal answer, not an error.

## Safety, layer by layer

Same idea as the read server's three layers, for writes:

1. **Credentials.** A new ServiceAccount `ops-write` whose Role allows only `get` and `patch` on `deployments` in the
   granted namespaces (`deploy/k8s/ops-write.yaml`). No delete, no create, no secrets, no other resources.
2. **Adapter.** The write server's Kubernetes client sends only `GET` and `PATCH`, and `PATCH` only to
   `/apis/apps/v1/namespaces/<ns>/deployments/<name>` with the restart annotation; anything else is refused before
   it is sent.
3. **Tool.** Fixed patch body, names validated, the namespace allowlist checked first, the approval in between.

Plus what the registry already does for the read server: strict input, timeouts, redaction of all output, audit.

**Levels.** The write server boots with `OPS_MAX_LEVEL=2` (`Level.Change`) and refuses 3 (`Level.Dangerous`) until
a dangerous tool exists. The read server keeps refusing anything above 1.

**Prompt injection.** The agent's `reason` is only shown to you; it never reaches the cluster. The form shows the
evidence the server read itself (step 3), not text from logs, so a log line saying "restart the api" cannot make
its own case. A lab scenario covers it: logs ask for a restart that nothing justifies; a good agent does not propose
it, and in the test the form is declined anyway.

## Code layout

- `packages/mcp-write`: entry point, config (`OPS_K8S_NAMESPACES`, its own ServiceAccount token), the write
  Kubernetes adapter, `k8s_rollout_restart`, the approval helper (`approve(ctx, proposal)` around the SDK's
  elicitation), tests.
- **Shared with the read server**, exported from `@ops-agent/mcp-server` as TypeScript source (like the watcher's
  `./agent` export): `registerTools`, `defineTool`, the types, the redactor, `httpGet`, `k8sLabel`. No copies.
- `deploy/k8s/ops-write.yaml`: the ServiceAccount and its Role. Not in the watcher's manifest: v2.0 runs the write
  server only next to an interactive client, so the cluster never holds a running process with write access.

## Tests

- Unit: approve, decline, closed form and no form support (only approve acts); rate limits; the adapter refusing
  any other method or path; the audit line.
- Integration on k3s with the real `ops-write` RBAC: the restart happens and the post-check sees new pods; the
  ServiceAccount cannot delete, create, read secrets or touch other namespaces (checked with `kubectl auth can-i`).
- Lab and evals: a scenario where a restart is the fix (pods stuck on a config the cluster has since fixed), and the
  injection scenario above. The eval's client approves or declines on the test's say.

## To verify before building

- Which protocol revision Claude Code speaks, and that it shows elicitation forms (the SDK supports them on both;
  the 2026-07-28 revision uses `inputRequired.elicit`). If a client cannot, the tool refuses: no form, no action.
- How long a form may stay open before the call times out on the client side; the tool's own timeout must allow
  for a human reading it.

## v2.1: out-of-band approval (sketch)

The watcher's report gets a proposal: id, action, reason, evidence, expiry (15 minutes). You approve with
`ops-agent approve <id>` (a small CLI that talks to the write server) or reject by doing nothing. The write server
re-checks the evidence when you approve, since things change in 15 minutes, and acts only if the problem is still
there. This needs a proposals store and a way to reach the write server, so it waits until v2.0 works.

## Plan: one PR each

1. This design doc.
2. `packages/mcp-write` skeleton: config, the write Kubernetes adapter, `ops-write` RBAC, shared exports from the
   read server, the approval helper. No tools yet.
3. `k8s_rollout_restart` with the full flow above, unit and integration tests.
4. Lab scenarios (restart is the fix; injection asks for one) and one eval run each.
