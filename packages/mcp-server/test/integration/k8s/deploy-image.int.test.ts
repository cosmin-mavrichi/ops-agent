import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type K3sFixture, startK3s } from "./k8s-fixture.js";

/**
 * The whole deployment, end to end: the image built from the repo's Dockerfile runs as a pod with the manifest and
 * the Secret from docs/deploy.md, finds a crash loop through its ServiceAccount, and writes the report to its
 * volume. Slow (image import, busybox pull), so it runs only on request:
 *   docker build -t ops-agent:dev . && OPS_E2E_IMAGE=ops-agent:dev pnpm exec vitest run test/integration/k8s/deploy-image
 * The investigation budget is 0: no model is called. The Image workflow runs it on every pull request.
 */
const IMAGE = process.env.OPS_E2E_IMAGE;
// containerd names a plain local image (ops-agent:dev) docker.io/library/ops-agent:dev; a registry name stays as is.
const containerdName = (image: string) => (image.includes("/") ? image : `docker.io/library/${image}`);
const WATCHER = readFileSync(new URL("../../../../../deploy/k8s/ops-watcher.yaml", import.meta.url), "utf8");

const CRASH_LOOP = `
apiVersion: v1
kind: Pod
metadata: { name: worker, namespace: app }
spec:
  containers:
    - name: worker
      image: busybox:1.37
      command: ["sh", "-c", "echo fatal: cannot reach redis; exit 1"]
`;

let k3s: K3sFixture;
let dir: string;

async function importImage(image: string) {
  dir = mkdtempSync(join(tmpdir(), "ops-e2e-"));
  const archive = join(dir, "image.tar");
  execFileSync("docker", ["save", "-o", archive, image]);
  await k3s.container.copyFilesToContainer([{ source: archive, target: "/tmp/image.tar" }]);
  const imported = await k3s.container.exec(["ctr", "images", "import", "/tmp/image.tar"]);
  if (imported.exitCode !== 0) throw new Error(`ctr images import failed: ${imported.output}`);
}

describe.skipIf(!IMAGE)("the built image deployed with deploy/k8s/ops-watcher.yaml", () => {
  beforeAll(async () => {
    if (!IMAGE) return;
    k3s = await startK3s();
    await importImage(IMAGE);
    await k3s.kubectl(
      "-n",
      "ops",
      "create",
      "secret",
      "generic",
      "ops-watcher",
      // No Postgres in this cluster: the watcher reports it unreachable, which is a finding too.
      "--from-literal=OPS_PG_URL=postgres://ops_ro:unused@127.0.0.1:1/app",
      "--from-literal=ANTHROPIC_API_KEY=sk-e2e-never-used",
      "--from-literal=OPS_WATCH_MAX_PER_HOUR=0",
      "--from-literal=OPS_WATCH_INTERVAL_S=10",
    );
    const local = WATCHER.replace("ghcr.io/cosmin-mavrichi/ops-agent:main", containerdName(IMAGE)).replace(
      "imagePullPolicy: Always",
      "imagePullPolicy: Never",
    );
    await k3s.apply(local);
    await k3s.apply(CRASH_LOOP);
  }, 300_000);

  afterAll(async () => {
    await k3s?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("finds the crash loop through its ServiceAccount and writes the incident to the report file", async () => {
    const reports = await vi.waitFor(
      async () => {
        const text = await k3s.kubectl(
          "-n",
          "ops",
          "exec",
          "deploy/ops-watcher",
          "--",
          "cat",
          "/var/lib/ops-watcher/reports.jsonl",
        );
        const lines = text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const findings = lines.flatMap((line) => line.findings ?? []).join("\n");
        expect(findings).toMatch(/^k8s_pods: app\/worker/m);
        return lines;
      },
      { timeout: 180_000, interval: 5_000 },
    );
    expect(reports[0]).toMatchObject({ event: "incident_not_investigated", incident: 1 });
    const findings = reports.flatMap((line) => line.findings ?? []).join("\n");
    expect(findings).toContain("pg_blocking: could not run");
  }, 200_000);
});
