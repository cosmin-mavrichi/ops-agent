import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type K3sFixture, startK3s } from "./k8s-fixture.js";

const manifest = (name: string) => readFileSync(new URL(`../../../../../deploy/k8s/${name}`, import.meta.url), "utf8");
const WATCHER = manifest("ops-watcher.yaml");
const WRITE_RBAC = manifest("ops-write.yaml");

let k3s: K3sFixture;

beforeAll(async () => {
  // startK3s has already applied deploy/k8s/ops-ro.yaml, as step 1 of docs/deploy.md does.
  k3s = await startK3s();
  await k3s.apply(WATCHER);
  await k3s.apply(WRITE_RBAC);
}, 240_000);

afterAll(async () => {
  await k3s?.stop();
});

/** `kubectl auth can-i` as a ServiceAccount in `ops`: "yes" or "no". `resource` may name a subresource (pods/log). */
async function canI(account: string, verb: string, resource: string, namespace: string): Promise<"yes" | "no"> {
  const as = `system:serviceaccount:ops:${account}`;
  // kubectl reads "pods/log" as the pod named "log"; a subresource has to be passed on its own.
  const [kind = resource, subresource] = resource.split("/");
  const subresourceArgs = subresource ? ["--subresource", subresource] : [];
  const args = ["auth", "can-i", verb, kind, ...subresourceArgs, "-n", namespace, "--as", as];
  // can-i exits 1 for "no", so read its output directly rather than through the fixture's throwing kubectl.
  const { stdout, output } = await k3s.container.exec(["kubectl", ...args]);
  // A misspelled resource only warns and then answers "no"; that must fail the test, not pass it.
  if (output.includes("doesn't have a resource type")) throw new Error(`can-i: unknown resource ${resource}`);
  const answer = stdout.trim();
  if (answer !== "yes" && answer !== "no") throw new Error(`can-i gave no answer: ${output}`);
  return answer;
}

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

describe("deploy/k8s/ops-write.yaml on a real cluster", () => {
  it.each([
    ["get", "deployments"],
    ["list", "deployments"],
    ["patch", "deployments"],
    ["get", "pods"],
    ["list", "pods"],
  ])("lets ops-write %s %s in its namespace", async (verb, resource) => {
    expect(await canI("ops-write", verb, resource, "app")).toBe("yes");
  });

  it.each([
    ["delete", "deployments"],
    ["create", "deployments"],
    ["update", "deployments"],
    ["patch", "deployments/scale"],
    ["delete", "pods"],
    ["create", "pods/exec"],
    ["get", "pods/log"],
    ["get", "secrets"],
    ["get", "configmaps"],
    ["patch", "statefulsets"],
  ])("does not let ops-write %s %s", async (verb, resource) => {
    expect(await canI("ops-write", verb, resource, "app")).toBe("no");
  });

  it("grants nothing outside its namespaces", async () => {
    expect(await canI("ops-write", "patch", "deployments", "kube-system")).toBe("no");
    expect(await canI("ops-write", "get", "pods", "kube-system")).toBe("no");
  });

  it("leaves the read-only ServiceAccount without write access", async () => {
    expect(await canI("ops-ro", "patch", "deployments", "app")).toBe("no");
  });

  it("checks subresources for real: ops-ro may read pods/log, which ops-write may not", async () => {
    expect(await canI("ops-ro", "get", "pods/log", "app")).toBe("yes");
  });
});
