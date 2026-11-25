import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { k8sChanges } from "../../../src/tools/k8s/changes.js";
import { opsTriage } from "../../../src/tools/triage.js";
import { startHarness } from "../../harness.js";
import { type K3sFixture, startK3s } from "./k8s-fixture.js";

const ENV_SECRET = "planted-rollout-env-6604";
const JOB_SECRET = "planted-job-env-1187";
// The same image under its full name: a new image string for the rollout without another pull.
const IMAGE = "busybox:1.37";
const SAME_IMAGE_FULL_NAME = "docker.io/library/busybox:1.37";

const API = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: app }
spec:
  replicas: 1
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: api
          image: ${IMAGE}
          command: ["sleep", "3600"]
          env: [{ name: DB_PASSWORD, value: ${ENV_SECRET} }]
`;

const job = (name: string, exitCode: number) => `
apiVersion: batch/v1
kind: Job
metadata: { name: ${name}, namespace: app }
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ${IMAGE}
          command: ["sh", "-c", "echo migrating; exit ${exitCode}"]
          env: [{ name: DATABASE_URL, value: ${JOB_SECRET} }]
`;

const POLICY_SECRET = "planted-policy-annotation-3318";
const LOCKDOWN = `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: lockdown, namespace: app, annotations: { owner-token: ${POLICY_SECRET} } }
spec:
  podSelector: { matchLabels: { app: api } }
  policyTypes: [Ingress]
`;
// An update closer to the creation than this reads as the creation itself.
const AFTER_CREATE_MS = 6_000;
const ALLOW_WEB = JSON.stringify({
  spec: { ingress: [{ from: [{ podSelector: { matchLabels: { app: "web" } } }], ports: [{ port: 8080 }] }] },
});

let k3s: K3sFixture;
const rollout = () => k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=150s");

beforeAll(async () => {
  k3s = await startK3s();
  await k3s.apply(API);
  await rollout();
  await k3s.kubectl("set", "image", "deployment/api", `api=${SAME_IMAGE_FULL_NAME}`, "-n", "app");
  await rollout();
  await k3s.kubectl("rollout", "restart", "deployment/api", "-n", "app");
  await rollout();
  await k3s.kubectl("set", "env", "deployment/api", "LOG_LEVEL=debug", "-n", "app");
  await rollout();
  await k3s.apply([job("migrate-ok", 0), job("migrate-bad", 1)].join("\n---\n"));
  await k3s.kubectl("wait", "--for=condition=Complete", "job/migrate-ok", "-n", "app", "--timeout=120s");
  await k3s.kubectl("wait", "--for=condition=Failed", "job/migrate-bad", "-n", "app", "--timeout=120s");
  await k3s.apply(LOCKDOWN);
  await sleep(AFTER_CREATE_MS);
  await k3s.kubectl("patch", "networkpolicy/lockdown", "-n", "app", "--type=merge", "-p", ALLOW_WEB);
}, 360_000);

afterAll(async () => {
  await k3s?.stop();
});

const changeOf = (changes: ReadonlyArray<{ object: string; change: string }>, object: string, prefix: string) =>
  changes.find((each) => each.object === object && each.change.startsWith(prefix));

describe("k8s_changes on k3s, as the ops-ro ServiceAccount", () => {
  it("tells rollouts apart, and reports both Jobs and the policy change", async () => {
    const h = await startHarness({ tools: [k8sChanges], k8s: k3s.ops });
    try {
      const { json, text } = await h.call("k8s_changes");
      const changes = json.changes;
      expect(changeOf(changes, "Deployment/api", "revision 2,")?.change).toBe(
        `revision 2, image api: ${IMAGE} → ${SAME_IMAGE_FULL_NAME}`,
      );
      expect(changeOf(changes, "Deployment/api", "revision 3,")?.change).toBe(
        "revision 3, restart (kubectl rollout restart): nothing else changed",
      );
      expect(changeOf(changes, "Deployment/api", "revision 4,")).toMatchObject({
        change: "revision 4, same images, pod template changed: env, config, resources or probes",
        current: true,
      });
      expect(changeOf(changes, "Job/migrate-ok", "succeeded")).toBeDefined();
      expect(changeOf(changes, "NetworkPolicy/lockdown", "changed")?.change).toBe(
        "changed; now applies to app=api: ingress allowed only from pods app=web on TCP 8080",
      );
      expect(json.problems).toEqual([expect.stringMatching(/^app\/Job\/migrate-bad: failed \(BackoffLimitExceeded\)/)]);
      expect(text).not.toContain(ENV_SECRET);
      expect(text).not.toContain(JOB_SECRET);
      expect(text).not.toContain(POLICY_SECRET);
    } finally {
      await h.close();
    }
  });

  it("puts the failed Job in ops_triage", async () => {
    const h = await startHarness({ tools: [opsTriage], k8s: k3s.ops });
    try {
      const triage = await vi.waitFor(async () => {
        const { json } = await h.call("ops_triage");
        expect(json.problems.k8s_changes).toBeDefined();
        return json;
      });
      expect(triage.problems.k8s_changes[0]).toMatch(/migrate-bad: failed/);
    } finally {
      await h.close();
    }
  });
});
