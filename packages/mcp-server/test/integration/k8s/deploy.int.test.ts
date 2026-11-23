import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type K3sFixture, startK3s } from "./k8s-fixture.js";

const WATCHER = readFileSync(new URL("../../../../../deploy/k8s/ops-watcher.yaml", import.meta.url), "utf8");

let k3s: K3sFixture;

beforeAll(async () => {
  // startK3s has already applied deploy/k8s/ops-ro.yaml, as step 1 of docs/deploy.md does.
  k3s = await startK3s();
  await k3s.apply(WATCHER);
}, 240_000);

afterAll(async () => {
  await k3s?.stop();
});

const podSpec = async () =>
  JSON.parse(await k3s.kubectl("get", "pods", "-n", "ops", "-l", "app=ops-watcher", "-o", "json")).items[0]?.spec;

describe("deploy/k8s/ops-watcher.yaml on a real cluster", () => {
  it("is accepted, and its pod runs as the read-only ServiceAccount, unprivileged", async () => {
    const spec = await vi.waitFor(
      async () => {
        const found = await podSpec();
        expect(found).toBeDefined();
        return found;
      },
      { timeout: 30_000, interval: 500 },
    );
    expect(spec.serviceAccountName).toBe("ops-ro");
    expect(spec.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000 });
    expect(spec.containers[0].securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("runs one watcher, which reads its settings from the ops-watcher Secret and writes reports to the volume", async () => {
    const deployment = JSON.parse(await k3s.kubectl("get", "deployment", "ops-watcher", "-n", "ops", "-o", "json"));
    expect(deployment.spec).toMatchObject({ replicas: 1, strategy: { type: "Recreate" } });
    const container = deployment.spec.template.spec.containers[0];
    expect(container.envFrom).toEqual([{ secretRef: { name: "ops-watcher" } }]);
    expect(container.env).toContainEqual({
      name: "OPS_WATCH_REPORT_FILE",
      value: "/var/lib/ops-watcher/reports.jsonl",
    });
    expect(container.volumeMounts).toContainEqual({ name: "reports", mountPath: "/var/lib/ops-watcher" });
    await k3s.kubectl("get", "pvc", "ops-watcher-reports", "-n", "ops");
  });

  it("grants the namespaces the watcher is told to inspect", async () => {
    const deployment = JSON.parse(await k3s.kubectl("get", "deployment", "ops-watcher", "-n", "ops", "-o", "json"));
    const namespaces = deployment.spec.template.spec.containers[0].env.find(
      (variable: { name: string }) => variable.name === "OPS_K8S_NAMESPACES",
    ).value;
    for (const namespace of namespaces.split(",")) {
      const allowed = await k3s.kubectl(
        "auth",
        "can-i",
        "list",
        "pods",
        "-n",
        namespace,
        "--as",
        "system:serviceaccount:ops:ops-ro",
      );
      expect(allowed.trim()).toBe("yes");
    }
  });
});
