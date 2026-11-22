import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { K3sContainer, type StartedK3sContainer } from "@testcontainers/k3s";
import { createK8sClient, type K8sConfig } from "../../../src/adapters/k8s.js";
import type { K8sClient } from "../../../src/types.js";

const IMAGE = "rancher/k3s:v1.37.2-k3s1";
const OPS_RBAC = readFileSync(new URL("../../../../../deploy/k8s/ops-ro.yaml", import.meta.url), "utf8");

export interface K3sFixture {
  container: StartedK3sContainer;
  /** Client authenticated as the ops-ro ServiceAccount, exactly as in production. */
  ops: K8sClient;
  connect(overrides?: Partial<K8sConfig>): K8sClient;
  /** The ServiceAccount token, for leak checks. */
  token: string;
  kubectl(...args: string[]): Promise<string>;
  apply(yaml: string): Promise<void>;
  /** Polls a jsonpath on an object until `done` accepts the value. */
  waitFor(resource: string, jsonpath: string, done: (value: string) => boolean, timeoutMs?: number): Promise<void>;
  /** Copies a directory out of a running pod into a new local temp dir, symlinks included. */
  copyFromPod(namespace: string, pod: string, path: string): Promise<string>;
  stop(): Promise<void>;
}

/** k3s in a throwaway container, with the `app` namespace and deploy/k8s/ops-ro.yaml applied. */
export async function startK3s(): Promise<K3sFixture> {
  const container = await new K3sContainer(IMAGE).start();

  let applied = 0;
  const kubectl = async (...args: string[]) => {
    const result = await container.exec(["kubectl", ...args]);
    if (result.exitCode !== 0) throw new Error(`kubectl ${args.join(" ")} failed: ${result.output}`);
    return result.stdout.trim();
  };
  const apply = async (yaml: string) => {
    const target = `/tmp/manifest-${applied++}.yaml`;
    await container.copyContentToContainer([{ content: yaml, target }]);
    await kubectl("apply", "-f", target);
  };

  // The API answers before the node can run pods; workloads applied earlier sit unscheduled.
  await kubectl("wait", "--for=condition=Ready", "node", "--all", "--timeout=120s");
  await kubectl("create", "namespace", "app");
  await waitUntil(() => kubectl("get", "serviceaccount", "default", "-n", "app"), 30_000);
  await apply(OPS_RBAC);
  const token = await kubectl("create", "token", "ops-ro", "-n", "ops", "--duration=1h");

  const kubeconfig = container.getKubeConfig();
  const server = /server: (\S+)/.exec(kubeconfig)?.[1];
  const caData = /certificate-authority-data: (\S+)/.exec(kubeconfig)?.[1];
  if (!server || !caData) throw new Error("unexpected kubeconfig format from k3s");

  /** A client as the ops ServiceAccount; overrides let tests shrink limits. */
  const ca = Buffer.from(caData, "base64").toString("utf8");
  const connect = (overrides: Partial<K8sConfig> = {}) =>
    createK8sClient({ server, ca, token: () => token, namespaces: ["app"], ...overrides });

  return {
    container,
    token,
    ops: connect(),
    connect,
    kubectl,
    apply,
    async waitFor(resource, jsonpath, done, timeoutMs = 150_000) {
      const deadline = Date.now() + timeoutMs;
      let last = "";
      while (Date.now() < deadline) {
        last = await kubectl("get", resource, "-n", "app", "-o", `jsonpath=${jsonpath}`).catch((e) => `<${e}>`);
        if (done(last)) return;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const described = await kubectl("describe", resource, "-n", "app").catch((e) => String(e));
      throw new Error(`timed out waiting for ${resource} ${jsonpath}; last value: ${last}\n${described}`);
    },
    async copyFromPod(namespace, pod, path) {
      // base64, because kubectl's output arrives as text and a tar archive is binary. The path is passed as
      // $1, not spliced into the script, so the shell never parses it.
      const script = 'tar -C "$1" -cf - . | base64';
      const archive = await kubectl("exec", "-n", namespace, pod, "--", "sh", "-c", script, "sh", path);
      const dir = mkdtempSync(join(tmpdir(), "pod-copy-"));
      execFileSync("tar", ["-x", "-C", dir], { input: Buffer.from(archive, "base64") });
      return dir;
    },
    stop: () => container.stop().then(() => undefined),
  };
}

async function waitUntil(check: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
