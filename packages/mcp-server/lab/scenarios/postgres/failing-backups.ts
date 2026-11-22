import { expect } from "vitest";
import { installCloudNativePg } from "../../../test/integration/k8s/cloudnative-pg.js";
import { type Lab, type Scenario, until } from "../../scenario.js";

const S3_SECRET_KEY = "planted-lab-s3-secret-6390";

// A CloudNativePG cluster whose backups go to an object store that no longer exists.
const CLUSTER = `
apiVersion: v1
kind: Secret
metadata: { name: backup-creds, namespace: app }
stringData: { ACCESS_KEY_ID: ops-lab, ACCESS_SECRET_KEY: ${S3_SECRET_KEY} }
---
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: app-db, namespace: app }
spec:
  instances: 1
  storage: { size: 1Gi }
  backup:
    barmanObjectStore:
      destinationPath: s3://backups/app-db
      endpointURL: http://minio.backup.svc:9000
      s3Credentials:
        accessKeyId: { name: backup-creds, key: ACCESS_KEY_ID }
        secretAccessKey: { name: backup-creds, key: ACCESS_SECRET_KEY }
---
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata: { name: app-db-nightly, namespace: app }
spec: { schedule: "0 0 2 * * *", immediate: true, cluster: { name: app-db } }
`;

const jsonpath = (lab: Lab, resource: string, path: string) =>
  lab.k3s.kubectl("get", resource, "-n", "app", "-o", `jsonpath=${path}`);

export const failingBackups: Scenario = {
  name: "failing-backups",
  rootCause:
    "The app-db Postgres cluster backs up to an object store endpoint (minio.backup.svc) that does not exist: " +
    "WAL archiving fails and no backup has ever completed, so the database cannot be restored.",
  secrets: [S3_SECRET_KEY],

  async break(lab) {
    await installCloudNativePg(lab.k3s);
    // The operator's webhook can refuse requests for a few seconds after its Deployment is ready.
    await until("CloudNativePG to accept the cluster", () => lab.k3s.apply(CLUSTER));
    await lab.k3s.kubectl("wait", "cluster/app-db", "-n", "app", "--for=condition=Ready", "--timeout=240s");
    // Backups to an unreachable store keep retrying in "running" for a long time; WAL archiving fails fast.
    await until("WAL archiving to fail", async () => {
      const archiving = "{.status.conditions[?(@.type=='ContinuousArchiving')].status}";
      expect(await jsonpath(lab, "cluster/app-db", archiving)).toBe("False");
    });
  },

  evidence: [
    {
      tool: "k8s_pg_backups",
      args: { namespace: "app" },
      shows: "app-db has no completed backup and cannot archive WAL to its object store",
      check: ({ json }) => {
        const appDb = json.clusters.find((cluster: { name: string }) => cluster.name === "app-db");
        expect(appDb.wal_archiving.ok).toBe(false);
        expect(appDb.problems).toContain("no backup of this cluster has ever completed");
        expect(appDb.problems.join("\n")).toContain("WAL archiving is failing");
      },
    },
    {
      tool: "k8s_logs",
      // CloudNativePG names instance pods <cluster>-<n>; the agent would read it from k8s_pods. Its JSON log
      // lines are long, so a short tail: 200 lines overflow the output limit and arrive cut off.
      args: { namespace: "app", pod: "app-db-1", container: "postgres", tail_lines: 25 },
      shows: "the WAL archiver cannot reach the object store endpoint",
      check: ({ json }) => {
        expect(json.lines.join("\n")).toMatch(/Could not connect to the endpoint URL.*minio\.backup\.svc/);
      },
    },
  ],
};
