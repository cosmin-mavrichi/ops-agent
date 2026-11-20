import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { k8sEvents, k8sPods } from "../../src/tools/k8s.js";
import { k8sLogs } from "../../src/tools/k8s-logs.js";
import { ToolError } from "../../src/types.js";
import { startHarness } from "../harness.js";
import { type K3sFixture, startK3s } from "./k8s-fixture.js";

const ENV_SECRET = "planted-env-secret-7781";
const LOG_SECRET = "sk_live_planted_k8s_4410";
const K8S_SECRET = "planted-k8s-secret-9902";

// The incident: a worker crash-looping (secret in env and in its logs), a pod killed for memory,
// a healthy API Deployment, and a Secret the agent must not be able to read.
const WORKLOAD = `
apiVersion: v1
kind: Pod
metadata: { name: crasher, namespace: app }
spec:
  containers:
    - name: app
      image: busybox:1.37
      command: ["sh", "-c", "echo starting worker; echo API_KEY=${LOG_SECRET}; echo 'fatal: cannot reach redis'; exit 3"]
      args: ["--password=${ENV_SECRET}"]
      env: [{ name: DB_PASSWORD, value: ${ENV_SECRET} }]
---
apiVersion: v1
kind: Pod
metadata: { name: oom, namespace: app }
spec:
  containers:
    - name: app
      image: busybox:1.37
      command: ["sh", "-c", "echo filling memory; a=x; while true; do a=\\"$a$a\\"; done"]
      resources: { limits: { memory: 32Mi } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: app }
spec:
  replicas: 1
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers: [{ name: app, image: "busybox:1.37", command: ["sleep", "3600"] }]
---
apiVersion: v1
kind: Secret
metadata: { name: app-secrets, namespace: app }
stringData: { password: ${K8S_SECRET} }
`;

let k3s: K3sFixture;
let h: Awaited<ReturnType<typeof startHarness>>;

beforeAll(async () => {
  k3s = await startK3s();
  await k3s.apply(WORKLOAD);
  await Promise.all([
    // A crash loop flips between terminated and waiting (CrashLoopBackOff); restarts are the stable signal.
    k3s.waitFor("pod/crasher", "{.status.containerStatuses[0].restartCount}", (v) => Number(v) >= 2),
    k3s.waitFor(
      "pod/oom",
      "{.status.containerStatuses[0].lastState.terminated.reason}{.status.containerStatuses[0].state.terminated.reason}",
      (v) => v.includes("OOMKilled"),
    ),
    k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=150s"),
  ]);
  h = await startHarness({ tools: [k8sPods, k8sEvents, k8sLogs], k8s: k3s.ops, knownSecrets: [k3s.token] });
}, 300_000);

afterAll(async () => {
  await h?.close();
  await k3s?.stop();
});

describe("k8s_pods against k3s", () => {
  it("explains each pod's state", async () => {
    const res = await h.call("k8s_pods");
    expect(res.isError).toBe(false);
    const byName = Object.fromEntries(res.json.pods.map((p: { name: string }) => [p.name, p]));

    const crasher = byName.crasher.containers[0];
    // Its current state flips between running, terminated and waiting; these hold at any moment.
    expect(byName.crasher).toMatchObject({ healthy: false });
    expect(crasher.restarts).toBeGreaterThanOrEqual(2);
    expect(crasher.last_termination).toMatchObject({ reason: "Error", exit_code: 3 });
    expect(byName.oom.containers[0]).toMatchObject({ limits: { memory: "32Mi" } });
    expect(JSON.stringify(byName.oom)).toContain("OOMKilled");

    const api = res.json.pods.find((p: { owner: string }) => p.owner === "Deployment/api");
    expect(api).toMatchObject({ healthy: true, ready: "1/1" });
  });

  it("never returns env, args or the token", async () => {
    const res = await h.call("k8s_pods");
    expect(res.text).not.toContain(ENV_SECRET);
    expect(res.text).not.toContain("DB_PASSWORD");
    expect(res.text).not.toContain(k3s.token);
  });
});

describe("k8s_events against k3s", () => {
  it("shows the crash loop back-off", async () => {
    const res = await h.call("k8s_events");
    expect(res.isError).toBe(false);
    expect(res.json.events).toContainEqual(expect.objectContaining({ reason: "BackOff", object: "Pod/crasher" }));
  });
});

describe("k8s_logs against k3s", () => {
  it("reads the dead container's last words, with the secret redacted", async () => {
    // The pod keeps restarting, so a read can race a restart (logs_unavailable); retry like the agent would.
    await vi.waitFor(
      async () => {
        const res = await h.call("k8s_logs", { namespace: "app", pod: "crasher", previous: true });
        expect(res.text).not.toContain(LOG_SECRET);
        expect(res.json.lines?.join("\n")).toContain("fatal: cannot reach redis");
      },
      { timeout: 30_000, interval: 1_000 },
    );
  }, 40_000);

  it("reports a missing pod as not found", async () => {
    const res = await h.call("k8s_logs", { namespace: "app", pod: "nope" });
    expect(res.json.error).toBe("not_found");
  });
});

describe("ops-ro ServiceAccount is actually read-only and scoped", () => {
  it.each([
    ["secrets", "/api/v1/namespaces/app/secrets"],
    ["configmaps", "/api/v1/namespaces/app/configmaps"],
    ["other namespaces", "/api/v1/namespaces/kube-system/pods"],
    ["cluster-wide pods", "/api/v1/pods"],
  ])("cannot read %s", async (_what, path) => {
    const err = await k3s.ops.getJson(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("forbidden");
  });

  it("cannot exec into pods or delete them", async () => {
    const can = (verb: string, resource: string) =>
      k3s
        .kubectl("auth", "can-i", verb, resource, "-n", "app", "--as=system:serviceaccount:ops:ops-ro")
        .catch((e) => String(e));
    expect(await can("create", "pods/exec")).toContain("no");
    expect(await can("delete", "pods")).toContain("no");
    expect(await can("get", "pods")).toBe("yes");
  });
});
