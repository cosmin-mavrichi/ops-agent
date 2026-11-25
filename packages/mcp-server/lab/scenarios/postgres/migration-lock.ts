import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { EMPTY_MIGRATION, runKnexMigrations } from "../../../test/integration/postgres/migration-tools.js";
import { type Lab, type Scenario, until } from "../../scenario.js";

const DATABASE_PASSWORD = "lab-migrate-db-pw-4416";
const GRANTS = readFileSync(new URL("../../../../../deploy/sql/ops_ro_migrations.sql", import.meta.url), "utf8");
const LOCKED = "Migration table is already locked";

// Failed and restarted at least this often: crash-looping, however the kubelet reports it in between.
const MIN_RESTARTS = 2;

/** What `knex migrate:latest` prints when it finds the lock held, then exits 1. */
const MIGRATE_SCRIPT = [
  "echo 'Using environment: production'",
  `echo "Can't take lock to run migrations: ${LOCKED}"`,
  `echo "If you are sure migrations are not running you can release the lock manually by running 'knex migrate:unlock'"`,
  "echo 'Error: Migration table is already locked'",
  "exit 1",
].join("\n");

const SERVE_SCRIPT = "echo 'api starting'; while true; do echo 'INFO GET /orders 200'; sleep 2; done";

/** The api, which runs its migrations in an init container before it starts, as many Node deployments do. */
const api = (version: string, migrate: "succeeds" | "locked") =>
  JSON.stringify({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "api", namespace: "app" },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "api" } },
      template: {
        metadata: { labels: { app: "api", version } },
        spec: {
          terminationGracePeriodSeconds: 1,
          initContainers: [
            {
              name: "migrate",
              image: "busybox:1.37",
              command: ["sh", "-c", migrate === "locked" ? MIGRATE_SCRIPT : "echo 'Already up to date'"],
              env: [{ name: "DATABASE_PASSWORD", value: DATABASE_PASSWORD }],
            },
          ],
          containers: [{ name: "api", image: "busybox:1.37", command: ["sh", "-c", SERVE_SCRIPT] }],
        },
      },
    },
  });

const newPod = (lab: Lab) =>
  lab.k3s.kubectl(
    "get",
    "pods",
    "-n",
    "app",
    "-l",
    "app=api,version=1.6.0",
    "-o",
    "jsonpath={.items[0].metadata.name}",
  );

export const migrationLock: Scenario = {
  name: "migration-lock",
  rootCause:
    "The api's 1.6.0 rollout is stuck: its migrate init container fails on every start because the knex " +
    "migration lock (knex_migrations_lock) is held in the database, left by an earlier migration run that " +
    "crashed. The old version keeps serving, so nothing is down yet.",
  symptom: "We deployed api 1.6.0 a while ago and it never came up; the old version is still the one serving.",
  fix:
    "Make sure no migration is running, release the lock (`knex migrate:unlock`, or set is_locked = 0 in " +
    "knex_migrations_lock), and let the init container retry.",
  lookAt:
    "pg_changes (the knex lock held), the new api pod's migrate init container failing in k8s_pods, and its logs.",
  secrets: [DATABASE_PASSWORD],

  async break(lab) {
    await runKnexMigrations(lab.db.container.getConnectionUri(), { "20261101120000_orders": EMPTY_MIGRATION });
    await lab.db.admin.query(GRANTS);
    await lab.k3s.apply(api("1.5.0", "succeeds"));
    await lab.k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=150s");
    // A migration killed mid-run, without a transaction around the lock, leaves it held.
    await lab.db.admin.query("UPDATE knex_migrations_lock SET is_locked = 1");
    await lab.k3s.apply(api("1.6.0", "locked"));
    // Between restarts k3s reports the container as terminated, not always as waiting in CrashLoopBackOff.
    await until("the new pod's migrate container to fail repeatedly", async () => {
      const restarts = await lab.k3s.kubectl(
        "get",
        "pods",
        "-n",
        "app",
        "-l",
        "app=api,version=1.6.0",
        "-o",
        "jsonpath={.items[0].status.initContainerStatuses[0].restartCount}",
      );
      expect(Number(restarts)).toBeGreaterThanOrEqual(MIN_RESTARTS);
    });
  },

  evidence: [
    {
      tool: "pg_changes",
      shows: "the knex migration lock is held in the database",
      check: ({ json }) => {
        expect(json.problems).toEqual([expect.stringContaining(LOCKED)]);
        expect(json.unreadable).toEqual([]);
      },
    },
    {
      tool: "k8s_pods",
      shows: "the new api pod is stuck in its migrate init container while the old one runs",
      check: ({ json }) => {
        const containers = json.pods.flatMap((pod: { containers: unknown[] }) => pod.containers);
        const stuck = (container: { init?: boolean; ready: boolean }) => container.init && !container.ready;
        const migrate = containers.find(stuck);
        expect(migrate).toMatchObject({ name: "migrate" });
        expect(migrate.restarts).toBeGreaterThanOrEqual(MIN_RESTARTS);
        expect(migrate.exit_code ?? migrate.last_termination?.exit_code).toBe(1);
      },
    },
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await newPod(lab), container: "migrate", previous: true }),
      shows: "the migrate container cannot take the knex lock",
      check: ({ json }) => {
        expect(json.lines.join("\n")).toContain(LOCKED);
      },
    },
  ],
};
