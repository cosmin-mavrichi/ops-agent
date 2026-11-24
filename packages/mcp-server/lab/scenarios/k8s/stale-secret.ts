import { expect } from "vitest";
import { type Lab, type Scenario, until } from "../../scenario.js";

const WRONG_PASSWORD = "lab-db-pw-typo-5512";
const RIGHT_PASSWORD = "lab-db-pw-5521";
const AUTH_FAILED = 'password authentication failed for user "app"';
const LOGGED_IN = "connected to app-db as app";
// Every line names where the password came from: a startup line alone scrolls out of the log tail in a minute.
const FROM_SECRET = "with the password read from Secret app-db at startup";
// Above the tool's own 4-minute limit, so a slow rollout ends as the tool's outcome rather than a lab timeout.
const RESTART_TIMEOUT_MS = 270_000;

const secret = (password: string) =>
  JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "app-db", namespace: "app" },
    stringData: { password },
  });

/**
 * An app that reads its database password once, at startup, from an environment variable filled from the Secret,
 * like most apps. The right password stands in for the database: it is in the command, which no tool returns.
 */
const APP_SCRIPT = [
  "while true; do",
  `if [ "$DB_PASSWORD" = "${RIGHT_PASSWORD}" ]; then`,
  `touch /tmp/ready; echo "INFO ${LOGGED_IN} ${FROM_SECRET}";`,
  "else",
  `echo 'ERROR cannot connect to app-db ${FROM_SECRET}: ${AUTH_FAILED}';`,
  "fi",
  "sleep 2",
  "done",
].join("\n");

const deployment = (name: string) =>
  JSON.stringify({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: "app" },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          terminationGracePeriodSeconds: 1,
          containers: [
            {
              name,
              image: "busybox:1.37",
              command: ["sh", "-c", APP_SCRIPT],
              env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "app-db", key: "password" } } }],
              // Ready only once logged in, so the stuck pods show as not Ready rather than as crashes.
              readinessProbe: { exec: { command: ["cat", "/tmp/ready"] }, periodSeconds: 2 },
            },
          ],
        },
      },
    },
  });

const podOf = (app: string) => (lab: Lab) =>
  lab.k3s.kubectl("get", "pods", "-n", "app", "-l", `app=${app}`, "-o", "jsonpath={.items[0].metadata.name}");

interface PodLine {
  readonly owner: string;
  readonly phase: string;
  readonly healthy: boolean;
  readonly ready: string;
  readonly restarts: number;
}
const podOwnedBy = (pods: readonly PodLine[], owner: string) => pods.find((pod) => pod.owner === owner);

export const staleSecret: Scenario = {
  name: "stale-secret",
  rootCause:
    "The api's pods read the database password from Secret app-db only at startup (an environment variable). " +
    "They started while the Secret still held the wrong password, so they keep failing to log in (password " +
    'authentication failed for user "app") and stay Running but not Ready, with no restarts. The Secret has ' +
    "since been corrected: the worker, started later and reading the same Secret, logs in fine.",
  symptom:
    "The api can't log in to its database since this morning's password change. We fixed the typo in the app-db " +
    "Secret since, but the api still fails. What's wrong?",
  fix: "Restart the api deployment so new pods read the corrected Secret (no change to the Secret needed).",
  lookAt:
    "Deployment/api: its pods Running but not Ready and their logs (password authentication failed); the " +
    "worker's logs showing a login with the same Secret.",
  secrets: [WRONG_PASSWORD, RIGHT_PASSWORD],
  write: { answer: "approve", expectedActions: ["k8s_rollout_restart"] },

  async break(lab) {
    await lab.k3s.apply([secret(WRONG_PASSWORD), deployment("api")].join("\n---\n"));
    await until("the api to fail its database login", async () => {
      const logs = await lab.k3s.kubectl("logs", "-n", "app", "deployment/api");
      expect(logs).toContain(AUTH_FAILED);
    });
    // The fix someone made: environment variables are not refreshed, so the running api keeps the old value.
    await lab.k3s.apply(secret(RIGHT_PASSWORD));
    await lab.k3s.apply(deployment("worker"));
    await lab.k3s.kubectl("rollout", "status", "deployment/worker", "-n", "app", "--timeout=150s");
  },

  evidence: [
    {
      tool: "ops_triage",
      shows: "one call points at the api's pod, Running but not Ready, and not at the worker",
      check: ({ json }) => {
        const pods = json.problems.k8s_pods.join("\n");
        expect(pods).toMatch(/app\/api-\S+ \(Deployment\/api\): Running, ready 0\/1/);
        expect(pods).not.toContain("worker-");
      },
    },
    {
      tool: "k8s_pods",
      shows: "the api pod is stuck not Ready without crashing, while the worker is healthy",
      check: ({ json }) => {
        expect(podOwnedBy(json.pods, "Deployment/api")).toMatchObject({
          phase: "Running",
          healthy: false,
          restarts: 0,
        });
        expect(podOwnedBy(json.pods, "Deployment/worker")).toMatchObject({ healthy: true });
      },
    },
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await podOf("api")(lab), tail_lines: 20 }),
      shows: "the api read its password from Secret app-db and the database refuses it",
      check: ({ json }) => {
        const lines = json.lines.join("\n");
        expect(lines).toContain(AUTH_FAILED);
        expect(lines).toContain(FROM_SECRET);
      },
    },
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await podOf("worker")(lab), tail_lines: 20 }),
      shows: "the worker, reading the same Secret, logs in",
      check: ({ json }) => {
        const lines = json.lines.join("\n");
        expect(lines).toContain(`${LOGGED_IN} ${FROM_SECRET}`);
      },
    },
    {
      tool: "k8s_rollout_restart",
      args: {
        namespace: "app",
        deployment: "api",
        reason: "The api pods started before the app-db Secret was corrected and still use the old password.",
      },
      shows: "an approved restart fixes it: the new api pods log in and stay healthy",
      attempts: "once",
      timeoutMs: RESTART_TIMEOUT_MS,
      check: ({ json }, lab) => {
        expect(json).toMatchObject({ status: "restarted", rollout: { status: "healthy" } });
        expect(lab.write?.forms.at(-1)).toContain("Restart deployment app/api?");
      },
    },
  ],
};
