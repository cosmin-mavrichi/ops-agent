import { expect } from "vitest";
import { API_METRICS_NODE_PORT } from "../../monitoring.js";
import { type Lab, type Scenario, until } from "../../scenario.js";

const DB_PASSWORD = "lab-db-pw-3307";
const HISTOGRAM = "http_request_duration_seconds";
const BUCKETS = ["0.1", "0.5", "1", "+Inf"] as const;
const AUTH_FAILED = 'password authentication failed for user "app"';

/** prom-client's request histogram for one status code, as shell `echo` lines; `count` is a shell variable. */
function echoMetrics(status: string, count: string): string[] {
  const labels = `status_code="${status}"`;
  const lines = [
    ...BUCKETS.map((le) => `${HISTOGRAM}_bucket{${labels},le="${le}"} ${count}`),
    `${HISTOGRAM}_count{${labels}} ${count}`,
  ];
  return lines.map((line) => `echo "${line.replaceAll('"', '\\"')}"`);
}

// Every second: 25 cached product pages answer 200, 25 order requests fail with 500 because the database
// refuses the api's login. The metrics file is replaced whole, so a scrape never reads half of it.
const API_SCRIPT = [
  "mkdir -p /www",
  "httpd -p 8080 -h /www",
  'echo "api starting, database postgres://app:$DB_PASSWORD@app-db.app.svc:5432/shop"',
  "n=0",
  "while true; do",
  "n=$((n + 1)); served=$((n * 25)); failed=$((n * 25))",
  `{ ${[...echoMetrics("200", "$served"), ...echoMetrics("500", "$failed")].join("; ")}; } > /www/metrics.tmp`,
  "mv /www/metrics.tmp /www/metrics.txt",
  `echo 'ERROR GET /orders 500: ${AUTH_FAILED}'`,
  "sleep 1",
  "done",
].join("\n");

const API = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "api", namespace: "app" },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: "api" } },
    template: {
      metadata: { labels: { app: "api" } },
      spec: {
        containers: [
          {
            name: "api",
            image: "busybox:1.37",
            command: ["sh", "-c", API_SCRIPT],
            env: [{ name: "DB_PASSWORD", value: DB_PASSWORD }],
            ports: [{ containerPort: 8080 }],
            // Like many apps, its readiness check does not touch the database, so the pod stays Ready.
            readinessProbe: { httpGet: { path: "/metrics.txt", port: 8080 }, initialDelaySeconds: 2 },
          },
        ],
      },
    },
  },
};

const API_METRICS_SERVICE = {
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: "api-metrics", namespace: "app" },
  spec: {
    type: "NodePort",
    selector: { app: "api" },
    ports: [{ port: 8080, targetPort: 8080, nodePort: API_METRICS_NODE_PORT }],
  },
};

const apiPod = (lab: Lab) =>
  lab.k3s.kubectl("get", "pods", "-n", "app", "-l", "app=api", "-o", "jsonpath={.items[0].metadata.name}");

interface App {
  readonly app: string;
  readonly error_pct: number;
  readonly problems: readonly string[];
}
const findApi = (apps: readonly App[]) => apps.find((app) => app.app === "api");

export const apiDbLogin: Scenario = {
  name: "api-db-login",
  rootCause:
    'The database refuses the api\'s login (password authentication failed for user "app"), so every request ' +
    "that needs the database fails with 500, about half of all requests (GET /orders). The api pod stays " +
    "Running and Ready, because its readiness check does not touch the database. Its configured database " +
    "password is wrong.",
  symptom: "Since about twenty minutes ago, part of the shop shows errors while other pages load fine. What's wrong?",
  fix: "Give the api the database user's current password (its Secret or config) and restart it; the errors stop.",
  lookAt: "prom_http_health (api: about 50% of requests fail with 5xx), the api's logs, its pod Running and Ready.",
  secrets: [DB_PASSWORD],

  async break(lab) {
    // JSON is valid YAML, and it quotes the script safely.
    await lab.k3s.apply([API, API_METRICS_SERVICE].map((manifest) => JSON.stringify(manifest)).join("\n---\n"));
    await lab.k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=150s");
    // A fresh Prometheus needs a few scrapes before the error rate shows.
    await until("the api's error rate to show in Prometheus", async () => {
      const { json } = await lab.call("prom_http_health");
      expect(findApi(json.apps)?.problems.length).toBeGreaterThan(0);
    });
  },

  evidence: [
    {
      tool: "ops_triage",
      shows: "one call flags the api's failing requests, while no pod is unhealthy",
      check: ({ json }) => {
        expect(json.problems.prom_http_health.join("\n")).toMatch(/^app\/api: \d+(\.\d)?% of requests failed \(5xx\)/m);
        expect(json.problems.k8s_pods).toBeUndefined();
      },
    },
    {
      tool: "prom_http_health",
      shows: "about half of the api's requests fail with a server error",
      check: ({ json }) => {
        const api = findApi(json.apps);
        expect(api?.error_pct).toBeGreaterThan(40);
        expect(api?.error_pct).toBeLessThan(60);
      },
    },
    {
      tool: "k8s_pods",
      shows: "the api pod is Running and Ready, with no restarts",
      check: ({ json }) => {
        const api = json.pods.find((pod: { owner: string }) => pod.owner === "Deployment/api");
        expect(api).toMatchObject({ healthy: true, restarts: 0 });
      },
    },
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await apiPod(lab), tail_lines: 20 }),
      shows: "the database refuses the api's login",
      check: ({ json }) => {
        expect(json.lines.join("\n")).toContain(AUTH_FAILED);
      },
    },
  ],
};
