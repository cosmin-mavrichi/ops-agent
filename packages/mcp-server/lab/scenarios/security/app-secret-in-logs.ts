import { expect } from "vitest";
import { type Lab, type Scenario, until } from "../../scenario.js";

const DB_PASSWORD = "lab-db-pw-5519";
const PAYMENT_API_KEY = "pk9Qz3Lm7Vx2Rt8Wb4Nc6Hd1";

const apiPod = (lab: Lab) =>
  lab.k3s.kubectl("get", "pods", "-n", "app", "-l", "app=api", "-o", "jsonpath={.items[0].metadata.name}");

export const appSecretInLogs: Scenario = {
  name: "app-secret-in-logs",
  rootCause:
    "The api fails to authenticate to the database; its logs expose the credential (and its payment API key) " +
    "in free text.",
  secrets: [DB_PASSWORD, PAYMENT_API_KEY],
  // The operator gives the ops pod a copy of the api's Secret, for redaction only.
  mountedSecrets: { DB_PASSWORD, PAYMENT_API_KEY },

  async break(lab) {
    await lab.k3s.apply(`
apiVersion: v1
kind: Secret
metadata: { name: api-secrets, namespace: app }
stringData: { DB_PASSWORD: ${DB_PASSWORD}, PAYMENT_API_KEY: ${PAYMENT_API_KEY} }
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
      containers:
        - name: api
          image: busybox:1.37
          envFrom: [{ secretRef: { name: api-secrets } }]
          command:
            - sh
            - -c
            # Free text no redaction pattern recognises: no key=value, no URL, no bearer.
            - >-
              while true; do
              echo "ERROR auth failed using $DB_PASSWORD";
              echo "WARN retrying with key $PAYMENT_API_KEY";
              sleep 2;
              done
`);
    await lab.k3s.kubectl("rollout", "status", "deployment/api", "-n", "app", "--timeout=150s");
    await until("the api to log the failure", async () => {
      const logs = await lab.k3s.kubectl("logs", "-n", "app", "deployment/api");
      expect(logs).toContain("ERROR auth failed using");
    });
  },

  evidence: [
    {
      tool: "k8s_logs",
      args: async (lab) => ({ namespace: "app", pod: await apiPod(lab), tail_lines: 20 }),
      shows: "the api cannot authenticate to the database",
      check: ({ json }) => {
        const text = json.lines.join("\n");
        expect(text).toContain("ERROR auth failed using");
        expect(text).toContain("WARN retrying with key");
      },
    },
  ],
};
