import { expect } from "vitest";
import { type Lab, type Scenario, until } from "../../scenario.js";

const REDIS_PASSWORD = "lab-redis-pw-4471";
const DB_PASSWORD = "lab-db-pw-8820";

const firstWorkerPod = (lab: Lab) =>
  lab.k3s.kubectl("get", "pods", "-n", "app", "-l", "app=worker", "-o", "jsonpath={.items[0].metadata.name}");

export const crashLoop: Scenario = {
  name: "crash-loop",
  // A DNS failure names a missing host. "Connection refused" read like the lab's freshly started Valkey had
  // restarted, a cause that is not part of this scenario.
  rootCause:
    "The worker Deployment is crash-looping: each start exits with code 1 because the Redis host it is " +
    "configured with (jobs-redis.app.svc) does not exist (getaddrinfo ENOTFOUND): a wrong or removed address, " +
    "not a cache outage or restart. The api Deployment is healthy.",
  symptom: "Background jobs stopped running about ten minutes ago. The API still answers. What's wrong?",
  fix: "Correct the worker's Redis address (or restore the jobs-redis Service it points to); the worker then recovers.",
  lookAt: "Deployment/worker: its pod status, its logs and BackOff events.",
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
              echo "connecting to redis://default:${REDIS_PASSWORD}@jobs-redis.app.svc:6379";
              echo "fatal: cannot reach redis: getaddrinfo ENOTFOUND jobs-redis.app.svc";
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
      tool: "ops_triage",
      shows: "one call points at the crash-looping worker and the restart back-off, and not at the api",
      check: ({ json }) => {
        const pods = json.problems.k8s_pods.join("\n");
        expect(pods).toMatch(/worker-.*last exited 1 \(Error\)/);
        expect(pods).not.toContain("api-");
        expect(json.problems.k8s_events.join("\n")).toMatch(/^BackOff on Pod\/worker-/m);
      },
    },
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
        expect(json.lines.join("\n")).toContain("getaddrinfo ENOTFOUND jobs-redis.app.svc");
      },
    },
  ],
};
