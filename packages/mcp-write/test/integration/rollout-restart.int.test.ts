import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The read server's k3s fixture: one cluster setup for both servers' integration tests.
import { type K3sFixture, startK3s } from "../../../mcp-server/test/integration/k8s/k8s-fixture.js";
import { createK8sWriteClient, type K8sWriteClient, RESTARTED_AT } from "../../src/adapters/k8s-write.js";
import { rolloutRestart } from "../../src/tools/k8s/rollout-restart.js";
import { approve, startHarness } from "../harness.js";

const WRITE_RBAC = readFileSync(new URL("../../../../deploy/k8s/ops-write.yaml", import.meta.url), "utf8");
const ENV_SECRET = "postgres://app:planted-in-env@db:5432/app";
const DEPLOYMENT = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: app }
spec:
  replicas: 2
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: api
          image: busybox:1.37
          command: ["sleep", "3600"]
          env: [{ name: DATABASE_URL, value: "${ENV_SECRET}" }]
`;
// Long enough for busybox pods to start on a CI runner, short enough for a test.
const ROLLOUT = { rolledOutWithinMs: 120_000, healthyForMs: 5_000, pollMs: 1_000 };

let k3s: K3sFixture;
let write: K8sWriteClient;

beforeAll(async () => {
  k3s = await startK3s();
  await k3s.apply(WRITE_RBAC);
  await k3s.apply(DEPLOYMENT);
  await k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=180s");
  // As in production: a short-lived token made for the session, never a token Secret.
  const token = await k3s.kubectl("create", "token", "ops-write", "-n", "ops", "--duration=1h");
  write = createK8sWriteClient({ server: k3s.server, ca: k3s.ca, token: () => token, namespaces: ["app"] });
}, 300_000);

afterAll(async () => {
  await k3s?.stop();
});

const annotation = () =>
  k3s.kubectl(
    "get",
    "deployment",
    "api",
    "-n",
    "app",
    "-o",
    `jsonpath={.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}`,
  );

describe("k8s_rollout_restart on k3s, as the ops-write ServiceAccount", () => {
  it("leaves the deployment alone on a dry run", async () => {
    const before = await write.getJson<{ metadata: { generation: number; resourceVersion: string } }>(
      "/apis/apps/v1/namespaces/app/deployments/api",
    );
    const restart = { namespace: "app", name: "api", restartedAt: new Date().toISOString() };
    await write.restartDeployment({ ...restart, resourceVersion: before.metadata.resourceVersion, mode: "dry_run" });
    expect(await annotation()).toBe("");
  });

  it("refuses a patch on a stale resourceVersion with a conflict", async () => {
    const restart = { namespace: "app", name: "api", restartedAt: new Date().toISOString(), mode: "apply" as const };
    await expect(write.restartDeployment({ ...restart, resourceVersion: "1" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await annotation()).toBe("");
  });

  it("restarts after an approval, sees the new pods healthy, and leaks no env", async () => {
    const h = await startHarness({ tools: [rolloutRestart], k8s: write, answer: approve, rollout: ROLLOUT });
    try {
      const args = { namespace: "app", deployment: "api", reason: "pods hold a stale connection to the database" };
      const result = await h.call("k8s_rollout_restart", args);
      expect(result.json).toMatchObject({ status: "restarted", rollout: { status: "healthy" } });
      // The annotation kubectl rollout restart sets, carried into the new pods.
      expect(await annotation()).toBe(result.json.restarted_at);
      const pods = JSON.parse(await k3s.kubectl("get", "pods", "-n", "app", "-l", "app=api", "-o", "json"));
      const restartedAtOf = (pod: { metadata: { annotations?: Record<string, string> } }) =>
        pod.metadata.annotations?.[RESTARTED_AT];
      expect(pods.items.map(restartedAtOf)).toContain(result.json.restarted_at);
      expect(JSON.stringify([h.forms, result, h.audit, h.logs])).not.toContain(ENV_SECRET);

      // The annotation now says it was just restarted: a second restart is refused before anyone is asked.
      const again = await h.call("k8s_rollout_restart", args);
      expect(again).toMatchObject({ isError: true, json: { error: "rate_limited" } });
      expect(h.forms).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 180_000);
});
