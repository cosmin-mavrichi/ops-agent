import { expect } from "vitest";
import { installCertManager } from "../../../test/integration/k8s/cert-manager.js";
import { type Lab, type Scenario, until } from "../../scenario.js";

const ANNOTATION_TOKEN = "planted-cert-annotation-token-2287";

// A self-signed root, a CA Issuer backed by its key, and an hour-long certificate the CA signs.
const PKI = `
apiVersion: cert-manager.io/v1
kind: Issuer
metadata: { name: selfsigned, namespace: app }
spec: { selfSigned: {} }
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: internal-ca, namespace: app }
spec:
  isCA: true
  commonName: internal-ca
  secretName: ca-key
  privateKey: { algorithm: ECDSA, size: 256 }
  issuerRef: { name: selfsigned, kind: Issuer }
---
apiVersion: cert-manager.io/v1
kind: Issuer
metadata: { name: internal-ca, namespace: app }
spec: { ca: { secretName: ca-key } }
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-tls
  namespace: app
  annotations: { ops.example/webhook-token: ${ANNOTATION_TOKEN} }
spec:
  secretName: api-tls
  duration: 1h
  renewBefore: 10m
  dnsNames: [api.app.svc]
  privateKey: { algorithm: ECDSA, size: 256 }
  issuerRef: { name: internal-ca, kind: Issuer }
`;

const readyOf = (lab: Lab, resource: string) =>
  lab.k3s.kubectl("get", resource, "-n", "app", "-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}");

export const expiringCertificate: Scenario = {
  name: "expiring-certificate",
  rootCause:
    "The internal CA's key Secret (ca-key) was deleted, so the internal-ca Issuer is not Ready and cert-manager " +
    "cannot reissue api-tls, which expires within the hour. (The pending reissue was triggered by a change to " +
    "api-tls's DNS names; its CertificateRequest is stuck for the same reason.)",
  symptom: "Monitoring warns that the API's TLS certificate expires within the hour and hasn't been renewed. Why not?",
  fix: "Restore the CA key Secret (or re-create the CA), then let cert-manager reissue api-tls.",
  lookAt: "Certificate api-tls and Issuer internal-ca (k8s_certificates).",
  secrets: [ANNOTATION_TOKEN],

  async break(lab) {
    await installCertManager(lab.k3s);
    // The webhook can refuse requests for a few seconds after its Deployment reports Available.
    await until("cert-manager to accept the PKI", () => lab.k3s.apply(PKI));
    await until("api-tls to be issued", async () => expect(await readyOf(lab, "certificate/api-tls")).toBe("True"));

    // The incident: someone deletes the CA (its Certificate and key), then a change forces a reissue.
    await lab.k3s.kubectl("delete", "certificate", "internal-ca", "-n", "app");
    await lab.k3s.kubectl("delete", "secret", "ca-key", "-n", "app");
    const moreNames = JSON.stringify({ spec: { dnsNames: ["api.app.svc", "api.example.test"] } });
    await lab.k3s.kubectl("patch", "certificate", "api-tls", "-n", "app", "--type=merge", "-p", moreNames);

    await until("the reissue to fail", async () => {
      expect(await readyOf(lab, "certificate/api-tls")).toBe("False");
      expect(await readyOf(lab, "issuer/internal-ca")).toBe("False");
    });
  },

  evidence: [
    {
      tool: "k8s_certificates",
      args: { namespace: "app" },
      shows: "api-tls cannot be reissued because its CA issuer lost its key, and it expires within the hour",
      check: ({ json }) => {
        const apiTls = json.certificates.find((cert: { name: string }) => cert.name === "api-tls");
        expect(apiTls).toMatchObject({ ready: false, issuer: { ref: "Issuer/internal-ca", ready: false } });
        const problems = apiTls.problems.join("\n");
        expect(problems).toMatch(/expires in [\d.]+ hours/);
        expect(problems).toContain("ca-key");
      },
    },
  ],
};
