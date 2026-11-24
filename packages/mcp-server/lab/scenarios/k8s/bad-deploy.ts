import { expect } from "vitest";
import { type Lab, type Scenario, until } from "../../scenario.js";

const PAYMENT_KEY = "lab-payment-key-7730";
const OLD_IMAGE = "busybox:1.36";
const NEW_IMAGE = "busybox:1.37";
const BUG = "TypeError: Cannot read properties of undefined (reading 'total') at applyDiscount (checkout.js:88)";

/** The api's script for one version: 1.4.0 serves checkouts, 1.5.0 fails every one with the same error. */
function apiScript(version: string, broken: "works" | "fails"): string {
  const checkout = broken === "fails" ? `echo 'ERROR POST /checkout 500: ${BUG}'` : "echo 'INFO POST /checkout 200'";
  return [
    `echo "api ${version} starting"`,
    "while true; do",
    "echo 'INFO GET /products 200';",
    `${checkout};`,
    "sleep 2",
    "done",
  ].join("\n");
}

const api = (image: string, version: string, broken: "works" | "fails") =>
  JSON.stringify({
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
              image,
              command: ["sh", "-c", apiScript(version, broken)],
              env: [{ name: "PAYMENT_KEY", value: PAYMENT_KEY }],
            },
          ],
        },
      },
    },
  });

const apiPod = (lab: Lab) =>
  lab.k3s.kubectl("get", "pods", "-n", "app", "-l", "app=api", "-o", "jsonpath={.items[0].metadata.name}");

export const badDeploy: Scenario = {
  name: "bad-deploy",
  // The version is in the logs: the image names are placeholders (LAB_NOTE), but the rollout that changed them and
  // the version the new pod reports are the real change.
  rootCause:
    "A new api version (1.5.0), rolled out minutes ago (the only change), fails every checkout with a TypeError " +
    "in applyDiscount since it started; product pages still work. The pod stays Running and Ready, so only the " +
    "logs and the rollout show it.",
  symptom: "Checkout started failing a few minutes ago; browsing the shop still works. What's wrong?",
  fix: "Roll the api back to the previous revision (kubectl rollout undo), then fix the bug in applyDiscount.",
  lookAt: "k8s_changes (the api's new revision minutes ago) and the api logs (TypeError on every checkout).",
  secrets: [PAYMENT_KEY],

  async break(lab) {
    await lab.k3s.apply(api(OLD_IMAGE, "1.4.0", "works"));
    await lab.k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=150s");
    await lab.k3s.apply(api(NEW_IMAGE, "1.5.0", "fails"));
    await lab.k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=150s");
    // The old pod is gone once the rollout settles, so the only pod is the new version.
    await until("the new version to fail checkouts", async () => {
      const logs = await lab.k3s.kubectl("logs", "-n", "app", "deployment/api");
      expect(logs).toContain("api 1.5.0 starting");
      expect(logs).toContain(BUG);
    });
  },

  evidence: [
    {
      tool: "k8s_changes",
      shows: "the api rolled out a new revision minutes ago",
      check: ({ json }) => {
        const current = json.changes.find(
          (change: { object: string; current?: boolean }) => change.object === "Deployment/api" && change.current,
        );
        expect(current).toMatchObject({
          kind: "rollout",
          change: `revision 2, image api: ${OLD_IMAGE} → ${NEW_IMAGE}`,
        });
        expect(current.at_ago_s).toBeLessThan(600);
      },
    },
    {
      tool: "k8s_pods",
      shows: "the api pod is Running and Ready: nothing crashes",
      check: ({ json }) => {
        expect(json.unhealthy).toBe(0);
        expect(json.pods[0]).toMatchObject({ owner: "Deployment/api", healthy: true });
      },
    },
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await apiPod(lab), tail_lines: 20 }),
      shows: "the new version fails every checkout with the same TypeError",
      check: ({ json }) => {
        const lines = json.lines.join("\n");
        expect(lines).toContain(BUG);
        expect(lines).toContain("GET /products 200");
      },
    },
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await apiPod(lab) }),
      shows: "the pod reports the version it runs",
      check: ({ json }) => {
        expect(json.lines.join("\n")).toContain("api 1.5.0 starting");
      },
    },
  ],
};
