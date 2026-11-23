import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { k8sPgBackups } from "../../../src/tools/k8s/pg-backups.js";
import { type Harness, startHarness } from "../../harness.js";
import { installCloudNativePgCrds } from "./cloudnative-pg.js";
import { type K3sFixture, startK3s } from "./k8s-fixture.js";

const S3_SECRET_KEY = "planted-s3-secret-key-8023";
const COMMAND_OUTPUT_SECRET = "planted-barman-output-4471";
const HOUR_MS = 3_600_000;

// A cluster with nightly backups to an object store; its credentials in a Secret the agent must not read.
const BACKUP_SETUP = `
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: app-db, namespace: app }
spec:
  instances: 1
  storage: { size: 1Gi }
---
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata: { name: app-db-nightly, namespace: app }
spec: { schedule: "0 0 2 * * *", cluster: { name: app-db } }
---
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata: { name: app-db-good, namespace: app }
spec: { cluster: { name: app-db } }
---
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata: { name: app-db-failed, namespace: app }
spec: { cluster: { name: app-db } }
---
apiVersion: v1
kind: Secret
metadata: { name: backup-creds, namespace: app }
stringData: { ACCESS_SECRET_KEY: ${S3_SECRET_KEY} }
`;

/** Without the operator nobody writes status, so the test writes what CloudNativePG would. */
async function setStatus(k3s: K3sFixture, resource: string, status: object): Promise<void> {
  const patch = JSON.stringify({ status });
  await k3s.kubectl("patch", resource, "-n", "app", "--subresource=status", "--type=merge", "-p", patch);
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();

let k3s: K3sFixture;
let h: Harness;

beforeAll(async () => {
  k3s = await startK3s();
  h = await startHarness({ tools: [k8sPgBackups], k8s: k3s.ops, knownSecrets: [k3s.token] });
}, 300_000);

afterAll(async () => {
  await h?.close();
  await k3s?.stop();
});

// In order: the first test runs before CloudNativePG exists in the cluster.
describe("k8s_pg_backups against k3s", () => {
  it("says CloudNativePG is not installed while its API does not exist", async () => {
    const res = await h.call("k8s_pg_backups");
    expect(res.json).toMatchObject({ error: "not_installed" });
    expect(res.json.message).toContain("CloudNativePG is not installed");
  });

  // Installs the CloudNativePG CRDs (download + server-side apply) inside the test, so the default 5s is too short.
  it("reads clusters, backups and schedules as the ops ServiceAccount", async () => {
    await installCloudNativePgCrds(k3s);
    await k3s.apply(BACKUP_SETUP);
    await setStatus(k3s, "cluster/app-db", {
      phase: "Cluster in healthy state",
      conditions: [
        {
          type: "ContinuousArchiving",
          status: "False",
          reason: "ContinuousArchivingFailing",
          message: "unexpected failure invoking barman-cloud-wal-archive",
          lastTransitionTime: hoursAgo(1),
        },
      ],
    });
    await setStatus(k3s, "backup/app-db-good", {
      phase: "completed",
      method: "barmanObjectStore",
      startedAt: hoursAgo(50),
      stoppedAt: hoursAgo(49),
      commandOutput: `uploaded, key=${COMMAND_OUTPUT_SECRET}`,
    });
    await setStatus(k3s, "backup/app-db-failed", {
      phase: "failed",
      method: "barmanObjectStore",
      startedAt: hoursAgo(2),
      error: "can't upload: endpoint unreachable",
    });

    const res = await h.call("k8s_pg_backups");
    expect(res.isError, res.text).toBe(false);
    expect(res.json.clusters[0]).toMatchObject({
      name: "app-db",
      wal_archiving: { ok: false },
      failed_since_last_success: 1,
      latest: { name: "app-db-failed", phase: "failed" },
      schedules: [{ name: "app-db-nightly", suspended: false }],
    });
    expect(res.json.clusters[0].problems, res.text).toContain("the last successful backup finished 2 days ago");
  }, 120_000);

  it("never returns backup output, the object store key or the token", async () => {
    const res = await h.call("k8s_pg_backups");
    expect(res.text).not.toContain(COMMAND_OUTPUT_SECRET);
    expect(res.text).not.toContain(S3_SECRET_KEY);
    expect(res.text).not.toContain(k3s.token);
  });
});
