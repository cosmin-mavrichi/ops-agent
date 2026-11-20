import { expect } from "vitest";
import { type Lab, type Scenario, until } from "../../scenario.js";

const REDIS_PASSWORD = "lab-redis-pw-4471";
const DB_PASSWORD = "lab-db-pw-8820";

const firstWorkerPod = (lab: Lab) =>
  lab.k3s.kubectl("get", "pods", "-n", "app", "-l", "app=worker", "-o", "jsonpath={.items[0].metadata.name}");

export const crashLoop: Scenario = {
  name: "crash-loop",
  rootCause:
    "The worker Deployment is crash-looping: each start exits with code 1 because it cannot connect to Redis " +
    "(connection refused). The api Deployment is healthy.",
  secrets: [REDIS_PASSWORD, DB_PASSWORD],

  async break(lab) {
    await lab.k3s.apply(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: worker, namespace: app }
spec:
  replicas: 1
  selector: { matchLabels: { app: worker } }
  template:
    metadata: { labels: { app: worker } }
    spec:
      containers:
        - name: worker
          image: busybox:1.37
          command:
            - sh
            - -c
            - >-
              echo "worker starting, queue=orders";
              echo "connecting to redis://default:${REDIS_PASSWORD}@redis:6379";
              echo "fatal: cannot reach redis: connection refused";
              exit 1
          env: [{ name: DB_PASSWORD, value: ${DB_PASSWORD} }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: app }
spec:
  replicas: 1
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers: [{ name: api, image: "busybox:1.37", command: ["sleep", "3600"] }]
`);
    await lab.k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=150s");
    await until("the worker to restart twice", async () => {
      const restarts = await lab.k3s.kubectl(
        "get",
        "pods",
        "-n",
        "app",
        "-l",
        "app=worker",
        "-o",
        "jsonpath={.items[0].status.containerStatuses[0].restartCount}",
      );
      expect(Number(restarts)).toBeGreaterThanOrEqual(2);
    });
  },

  evidence: [
    {
      tool: "k8s_pods",
      shows: "the worker is unhealthy and keeps exiting with code 1, while the api is fine",
      check: ({ json }) => {
        const worker = json.pods.find((p: { owner: string }) => p.owner === "Deployment/worker");
        const api = json.pods.find((p: { owner: string }) => p.owner === "Deployment/api");
        expect(worker).toMatchObject({ healthy: false });
        expect(worker.restarts).toBeGreaterThanOrEqual(2);
        expect(worker.containers[0].last_termination).toMatchObject({ reason: "Error", exit_code: 1 });
        expect(api).toMatchObject({ healthy: true });
      },
    },
    {
      tool: "k8s_events",
      shows: "Kubernetes is backing off restarts of the worker pod",
      check: ({ json }) => {
        const backOff = json.events.find(
          (e: { reason: string; object: string }) => e.reason === "BackOff" && e.object.startsWith("Pod/worker-"),
        );
        expect(backOff).toBeDefined();
      },
    },
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await firstWorkerPod(lab), previous: true }),
      shows: "the crashed container's last words name Redis as the cause",
      check: ({ json }) => {
        expect(json.lines.join("\n")).toContain("fatal: cannot reach redis: connection refused");
      },
    },
  ],
};
