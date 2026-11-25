import { expect } from "vitest";
import { type Lab, type Scenario, until } from "../../scenario.js";

const PRICING_KEY = "lab-pricing-key-4471";
const OK = "INFO GET /products 200";
const UNREACHABLE = "ERROR GET /products 502: cannot reach pricing";

const API_SCRIPT = [
  "echo 'api starting'",
  "while true; do",
  `if wget -q -T 2 -O /dev/null http://pricing:8080/; then echo '${OK}'; else echo '${UNREACHABLE}'; fi;`,
  "sleep 2",
  "done",
].join("\n");

const deployment = (name: string, command: string, env: ReadonlyArray<{ name: string; value: string }>) => ({
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
        containers: [{ name, image: "busybox:1.37", command: ["sh", "-c", command], env }],
      },
    },
  },
});

const PRICING_SERVICE = {
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: "pricing", namespace: "app" },
  spec: { selector: { app: "pricing" }, ports: [{ port: 8080 }] },
};

// Verbose: the pricing logs show the api's requests arriving, then stopping, so pricing is plainly up and listening.
const SERVE_PRICES = [
  "mkdir -p /www && echo '{\"price\":42}' > /www/index.html",
  "echo 'pricing listening on :8080'",
  "exec httpd -f -vv -p 8080 -h /www 2>&1",
].join(" && ");

const WORKLOADS = [
  deployment("pricing", SERVE_PRICES, []),
  PRICING_SERVICE,
  deployment("api", API_SCRIPT, [{ name: "PRICING_KEY", value: PRICING_KEY }]),
]
  .map((manifest) => JSON.stringify(manifest))
  .join("\n---\n");

// Meant for the web frontend only; the api, which also calls pricing, was forgotten.
const LOCKDOWN = JSON.stringify({
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: { name: "pricing-lockdown", namespace: "app" },
  spec: {
    podSelector: { matchLabels: { app: "pricing" } },
    policyTypes: ["Ingress"],
    ingress: [{ from: [{ podSelector: { matchLabels: { app: "web" } } }], ports: [{ port: 8080 }] }],
  },
});

const podOf = (lab: Lab, app: string) =>
  lab.k3s.kubectl("get", "pods", "-n", "app", "-l", `app=${app}`, "-o", "jsonpath={.items[0].metadata.name}");

const recentApiLogs = (lab: Lab) => lab.k3s.kubectl("logs", "-n", "app", "deployment/api", "--tail=3");

export const networkPolicy: Scenario = {
  name: "network-policy",
  rootCause:
    "NetworkPolicy pricing-lockdown, created minutes ago, lets only pods labelled app=web reach the pricing pods. " +
    "The api (app=api) also calls pricing, so its requests now fail and product pages fail with 502. " +
    "Pricing itself is healthy, and nothing was deployed.",
  symptom: "Product pages started failing with 502 errors a few minutes ago. Nothing was deployed.",
  fix: "Let the api through: add a rule allowing pods app=api on TCP 8080 to pricing-lockdown (or remove the policy).",
  lookAt:
    "k8s_changes (NetworkPolicy pricing-lockdown minutes ago, ingress only from app=web), the api logs (pricing " +
    "unreachable since then), the pricing logs and k8s_pods (pricing up and listening).",
  secrets: [PRICING_KEY],

  async break(lab) {
    await lab.k3s.apply(WORKLOADS);
    await lab.k3s.kubectl("rollout", "status", "deployment/pricing", "-n", "app", "--timeout=150s");
    await lab.k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=150s");
    await until("the api to reach pricing", async () => {
      expect(await recentApiLogs(lab)).toContain(OK);
    });
    await lab.k3s.apply(LOCKDOWN);
    // Settled: the last lines are all timeouts, as by the time someone reports it.
    await until("the policy to block the api", async () => {
      expect(await recentApiLogs(lab)).not.toContain(OK);
    });
  },

  evidence: [
    {
      tool: "k8s_changes",
      shows: "NetworkPolicy pricing-lockdown was created minutes ago and lets only app=web reach pricing",
      check: ({ json }) => {
        const policy = json.changes.find(
          (change: { object: string }) => change.object === "NetworkPolicy/pricing-lockdown",
        );
        expect(policy.change).toBe(
          "created; now applies to app=pricing: ingress allowed only from pods app=web on TCP 8080",
        );
        expect(policy.at_ago_s).toBeLessThan(600);
      },
    },
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await podOf(lab, "api"), tail_lines: 20 }),
      shows: "the api's calls to pricing worked, then started failing",
      check: ({ json }) => {
        const lines = json.lines.join("\n");
        expect(lines).toContain(UNREACHABLE);
      },
    },
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await podOf(lab, "pricing"), tail_lines: 50 }),
      shows: "pricing is up and listening on 8080, and served the api's requests before the policy",
      check: ({ json }) => {
        const lines = json.lines.join("\n");
        expect(lines).toContain("pricing listening on :8080");
        expect(lines).toContain("response:200");
      },
    },
  ],
};
