import { describe, expect, it } from "vitest";
import {
  k8sPgBackups,
  type PgBackup,
  type PgCluster,
  type PgScheduledBackup,
  summarizeCluster,
} from "../../../src/tools/k8s/pg-backups.js";
import { ToolError } from "../../../src/types.js";
import { useHarness } from "../../harness.js";
import { ago, fakeK8s, NOW } from "./fake-k8s.js";

const harness = useHarness();

const COMMAND_OUTPUT_SECRET = "planted-barman-output-secret-5150";
const HOUR = 3_600;

const cluster = (name: string, archiving: "True" | "False"): PgCluster => ({
  metadata: { name, namespace: "app" },
  status: {
    phase: "Cluster in healthy state",
    conditions: [
      { type: "ContinuousArchiving", status: archiving, reason: "x", message: "could not reach the object store" },
    ],
  },
});

const backup = (name: string, phase: string, startedHoursAgo: number, error?: string) => ({
  metadata: { name, namespace: "app" },
  spec: { cluster: { name: "app-db" }, method: "barmanObjectStore" },
  status: {
    phase,
    startedAt: ago(startedHoursAgo * HOUR),
    stoppedAt: ago(startedHoursAgo * HOUR - 300),
    error,
    // Real backups carry barman's output and credential references; the tool must not read them.
    commandOutput: `upload ok, key=${COMMAND_OUTPUT_SECRET}`,
    s3Credentials: { secretAccessKey: { name: "backup-creds", key: "ACCESS_SECRET_KEY" } },
  },
});

// The incident: the last good backup is three days old, and the two nightly runs since then failed.
const backups: PgBackup[] = [
  backup("app-db-20261117", "completed", 72),
  backup("app-db-20261118", "failed", 48, "can't upload: endpoint http://minio.backup:9000 unreachable"),
  backup("app-db-20261119", "failed", 24, "can't upload: endpoint http://minio.backup:9000 unreachable"),
];

const nightly: PgScheduledBackup = {
  metadata: { name: "app-db-nightly", namespace: "app" },
  spec: { cluster: { name: "app-db" }, schedule: "0 0 2 * * *", suspend: false },
};

describe("summarizeCluster", () => {
  it("finds the last success and counts the failures since, newest backup first", () => {
    const summary = summarizeCluster(cluster("app-db", "False"), { backups, schedules: [nightly] }, NOW, 26);
    expect(summary).toMatchObject({
      name: "app-db",
      wal_archiving: { ok: false, message: "could not reach the object store" },
      last_successful_backup_ago_s: 72 * HOUR - 300,
      failed_since_last_success: 2,
      latest: { name: "app-db-20261119", phase: "failed", method: "barmanObjectStore", started_ago_s: 24 * HOUR },
    });
    expect(summary.problems).toEqual([
      "WAL archiving is failing, so point-in-time recovery is not possible: could not reach the object store",
      "the last successful backup finished 3 days ago",
      "2 backups failed since the last successful one; latest: can't upload: endpoint http://minio.backup:9000 unreachable",
    ]);
  });

  it("reports nothing for a fresh backup with working archiving", () => {
    const fresh = [backup("app-db-today", "completed", 2)];
    const summary = summarizeCluster(cluster("app-db", "True"), { backups: fresh, schedules: [nightly] }, NOW, 26);
    expect(summary.problems).toEqual([]);
  });

  it("flags a cluster that was never backed up, has no schedule, or a suspended one", () => {
    const suspended = { ...nightly, spec: { ...nightly.spec, suspend: true } };
    const never = summarizeCluster(cluster("app-db", "True"), { backups: [], schedules: [] }, NOW, 26);
    const paused = summarizeCluster(cluster("app-db", "True"), { backups: [], schedules: [suspended] }, NOW, 26);
    expect(never.problems).toEqual([
      "no backup of this cluster has ever completed",
      "no ScheduledBackup: backups only run when someone starts one",
    ]);
    expect(paused.problems).toContain("ScheduledBackup app-db-nightly is suspended");
  });

  it("ignores backups and schedules of other clusters", () => {
    const summary = summarizeCluster(cluster("other-db", "True"), { backups, schedules: [nightly] }, NOW, 26);
    expect(summary).toMatchObject({ latest: null, failed_since_last_success: 0, schedules: [] });
  });
});

describe("k8s_pg_backups (unit)", () => {
  it("reads clusters, backups and schedules, never backup output or credentials", async () => {
    const k8s = fakeK8s(
      {
        "/clusters": { items: [cluster("app-db", "False")] },
        "/backups": { items: backups },
        "/scheduledbackups": { items: [nightly] },
      },
      ["app"],
    );
    const h = await harness({ tools: [k8sPgBackups], k8s: k8s.client });
    const res = await h.call("k8s_pg_backups");

    expect(res.isError).toBe(false);
    expect(res.json.clusters[0]).toMatchObject({ name: "app-db", failed_since_last_success: 2 });
    expect(k8s.calls.map((call) => call.path).sort()).toEqual([
      "/apis/postgresql.cnpg.io/v1/namespaces/app/backups",
      "/apis/postgresql.cnpg.io/v1/namespaces/app/clusters",
      "/apis/postgresql.cnpg.io/v1/namespaces/app/scheduledbackups",
    ]);
    expect(res.text).not.toContain(COMMAND_OUTPUT_SECRET);
    expect(res.text).not.toContain("ACCESS_SECRET_KEY");
  });

  it("says CloudNativePG is not installed when its API does not exist", async () => {
    const notFound = () => {
      throw new ToolError("not_found", "/apis/postgresql.cnpg.io/v1/namespaces/app/clusters does not exist");
    };
    const k8s = fakeK8s({ "/clusters": notFound }, ["app"]);
    const h = await harness({ tools: [k8sPgBackups], k8s: k8s.client });
    const res = await h.call("k8s_pg_backups");
    expect(res.json).toMatchObject({ error: "not_installed" });
    expect(res.json.message).toContain("CloudNativePG is not installed");
  });
});
