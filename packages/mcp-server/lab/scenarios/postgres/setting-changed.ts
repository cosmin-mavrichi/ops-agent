import { expect } from "vitest";
import { type Lab, type Scenario, until } from "../../scenario.js";

const EXPORT_TOKEN = "lab-export-token-9902";
const KILLED = "terminating connection due to idle-in-transaction timeout";
// The api checks for this file, so its logs change when the setting does without a rollout (another change).
const MARKER = "/tmp/timeout-on";

// Each export keeps a transaction open while it writes the file (about 3s idle), which the new 2s limit kills.
const API_SCRIPT = [
  "echo 'api starting'",
  "while true; do",
  `if [ -f ${MARKER} ]; then echo 'ERROR export 4411 failed: error: ${KILLED}';`,
  "else echo 'INFO export 4411 done in 3.4s'; fi;",
  "echo 'INFO GET /orders 200';",
  "sleep 2",
  "done",
].join("\n");

const API = JSON.stringify({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "api", namespace: "app" },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: "api" } },
    template: {
      metadata: { labels: { app: "api" } },
      spec: {
        terminationGracePeriodSeconds: 1,
        containers: [
          {
            name: "api",
            image: "busybox:1.37",
            command: ["sh", "-c", API_SCRIPT],
            env: [{ name: "EXPORT_TOKEN", value: EXPORT_TOKEN }],
          },
        ],
      },
    },
  },
});

const apiPod = (lab: Lab) =>
  lab.k3s.kubectl("get", "pods", "-n", "app", "-l", "app=api", "-o", "jsonpath={.items[0].metadata.name}");

export const settingChanged: Scenario = {
  name: "db-setting-changed",
  rootCause:
    "Someone set idle_in_transaction_session_timeout to 2s with ALTER SYSTEM and reloaded Postgres minutes " +
    "ago. Exports keep a transaction open while they write their file, so Postgres now kills their connection " +
    "and every export fails; everything else works.",
  symptom: "Data exports started failing a few minutes ago with connection errors; the rest of the app is fine.",
  fix:
    "Put the setting back (ALTER SYSTEM RESET idle_in_transaction_session_timeout; SELECT pg_reload_conf()), " +
    "or set a longer value for the exporting role; longer term, don't hold a transaction open while writing files.",
  lookAt:
    "pg_changes (a configuration reload minutes ago, idle_in_transaction_session_timeout = 2s set by ALTER " +
    "SYSTEM) and the api logs (exports killed by the idle-in-transaction timeout since then).",
  secrets: [EXPORT_TOKEN],

  async break(lab) {
    await lab.k3s.apply(API);
    await lab.k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=150s");
    await lab.db.admin.query("ALTER SYSTEM SET idle_in_transaction_session_timeout = '2s'");
    await lab.db.admin.query("SELECT pg_reload_conf()");
    await lab.k3s.kubectl("exec", "-n", "app", "deployment/api", "--", "touch", MARKER);
    await until("exports to fail", async () => {
      expect(await lab.k3s.kubectl("logs", "-n", "app", "deployment/api", "--tail=4")).toContain(KILLED);
    });
  },

  evidence: [
    {
      tool: "pg_changes",
      shows: "the configuration was reloaded minutes ago with a 2s idle-in-transaction timeout set by ALTER SYSTEM",
      check: ({ json }) => {
        const reload = json.changes.find((change: { kind: string }) => change.kind === "config_reload");
        expect(reload.at_ago_s).toBeLessThan(600);
        expect(json.settings).toContain("idle_in_transaction_session_timeout = 2s (ALTER SYSTEM)");
      },
    },
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await apiPod(lab), tail_lines: 20 }),
      shows: "exports fail because Postgres kills their idle transaction, while other requests succeed",
      check: ({ json }) => {
        const lines = json.lines.join("\n");
        expect(lines).toContain(KILLED);
        expect(lines).toContain("GET /orders 200");
      },
    },
  ],
};
