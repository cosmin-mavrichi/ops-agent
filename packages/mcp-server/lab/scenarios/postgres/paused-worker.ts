import { readFileSync } from "node:fs";
import { PgBoss } from "pg-boss";
import { expect } from "vitest";
import { type Lab, type Scenario, until } from "../../scenario.js";

const PAYLOAD_SECRET = "lab-export-payload-key-5570";
const EXPORT_JOBS = 40;
const GRANTS = readFileSync(new URL("../../../../../deploy/sql/ops_ro_pgboss.sql", import.meta.url), "utf8");

const WORKER = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: export-worker, namespace: app }
spec:
  replicas: 1
  selector: { matchLabels: { app: export-worker } }
  template:
    metadata: { labels: { app: export-worker } }
    spec:
      containers: [{ name: worker, image: "busybox:1.37", command: ["sleep", "3600"] }]
`;

/**
 * The API: it enqueues exports and works the emails queue itself. Its pg-boss instance also refreshes the
 * queue counters, as any running instance does. Runs in the lab process against the lab database.
 */
async function startApi(lab: Lab): Promise<PgBoss> {
  const api = new PgBoss({
    connectionString: lab.db.container.getConnectionUri(),
    monitorIntervalSeconds: 1,
    superviseIntervalSeconds: 1,
  });
  api.on("error", () => {});
  await api.start();
  lab.onStop(() => api.stop({ graceful: false, timeout: 1_000 }));
  await api.createQueue("exports");
  await api.createQueue("emails");
  await api.work("emails", { pollingIntervalSeconds: 0.5 }, async () => {});
  for (let i = 0; i < EXPORT_JOBS; i++) {
    await api.send("exports", { account: `acct-${i}`, storageKey: PAYLOAD_SECRET });
    await api.send("emails", { template: "receipt" });
  }
  return api;
}

type QueueJson = { queues: Array<{ name: string; ready: number; problems: string[] }> };
const exportsQueue = (json: QueueJson) => json.queues.find((queue) => queue.name === "exports");

export const pausedWorker: Scenario = {
  name: "paused-worker",
  rootCause:
    "The export-worker Deployment was scaled to 0, so nothing works the pg-boss exports queue: its jobs pile " +
    "up while the emails queue, worked by the API, stays healthy.",
  secrets: [PAYLOAD_SECRET],

  async break(lab) {
    await lab.k3s.apply(WORKER);
    await lab.k3s.kubectl("rollout", "status", "deployment/export-worker", "-n", "app", "--timeout=150s");
    await lab.k3s.kubectl("scale", "deployment/export-worker", "-n", "app", "--replicas=0");
    await startApi(lab);
    await lab.db.admin.query(GRANTS);
    await until("pg-boss to count the exports backlog", async () => {
      const { json } = await lab.call("pg_job_queues");
      expect(exportsQueue(json)?.ready).toBe(EXPORT_JOBS);
    });
  },

  evidence: [
    {
      tool: "pg_job_queues",
      shows: "the exports queue has jobs ready and nothing working it, while emails is fine",
      check: ({ json }) => {
        expect(exportsQueue(json)?.problems.join("\n")).toContain("nothing is working this queue");
        const emails = json.queues.find((queue: { name: string }) => queue.name === "emails");
        expect(emails.problems).toEqual([]);
      },
    },
    {
      tool: "k8s_events",
      args: { namespace: "app", warnings_only: false },
      shows: "the export worker was scaled down to zero",
      check: ({ json }) => {
        const scaled = json.events.find(
          (event: { object: string; reason: string }) =>
            event.object === "Deployment/export-worker" && event.reason === "ScalingReplicaSet",
        );
        expect(scaled?.message).toMatch(/Scaled down .* to 0/);
      },
    },
  ],
};
