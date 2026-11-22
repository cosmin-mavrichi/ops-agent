import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { k8sCertificates } from "../../../src/tools/k8s/certificates.js";
import { type Harness, startHarness } from "../../harness.js";
import { installCertManagerCrds } from "./cert-manager.js";
import { type K3sFixture, startK3s } from "./k8s-fixture.js";

const TLS_KEY_SECRET = "planted-tls-private-key-6612";
const DAY_MS = 86_400_000;

// A Certificate signed by a CA Issuer, its issued key in a Secret the agent must never read.
const CERTIFICATES = `
apiVersion: cert-manager.io/v1
kind: Issuer
metadata: { name: internal-ca, namespace: app }
spec: { ca: { secretName: ca-key } }
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: api-tls, namespace: app }
spec:
  secretName: api-tls
  dnsNames: [api.example.test]
  issuerRef: { name: internal-ca, kind: Issuer }
---
apiVersion: v1
kind: Secret
metadata: { name: api-tls, namespace: app }
type: Opaque
stringData: { tls.key: ${TLS_KEY_SECRET} }
`;

/** Without the controller nobody writes status, so the test writes what cert-manager would. */
async function setStatus(k3s: K3sFixture, resource: string, status: object): Promise<void> {
  const patch = JSON.stringify({ status });
  await k3s.kubectl("patch", resource, "-n", "app", "--subresource=status", "--type=merge", "-p", patch);
}

const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const condition = (status: "True" | "False", reason: string, message: string) => [
  { type: "Ready", status, reason, message, lastTransitionTime: new Date().toISOString() },
];

let k3s: K3sFixture;
let h: Harness;

beforeAll(async () => {
  k3s = await startK3s();
  h = await startHarness({ tools: [k8sCertificates], k8s: k3s.ops, knownSecrets: [k3s.token] });
}, 300_000);

afterAll(async () => {
  await h?.close();
  await k3s?.stop();
});

// In order: the first test runs before cert-manager exists in the cluster.
describe("k8s_certificates against k3s", () => {
  it("says cert-manager is not installed while its API does not exist", async () => {
    const res = await h.call("k8s_certificates");
    expect(res.json).toMatchObject({ error: "unavailable" });
    expect(res.json.message).toContain("cert-manager is not installed");
  });

  // Installs the cert-manager CRDs (download + apply) inside the test, so the default 5s is too short.
  it("reads Certificates and Issuers as the ops ServiceAccount and explains a failing renewal", async () => {
    await installCertManagerCrds(k3s);
    await k3s.apply(CERTIFICATES);
    await setStatus(k3s, "issuer/internal-ca", {
      conditions: condition("False", "ErrGetKeyPair", 'Error getting keypair for CA issuer: secret "ca-key" not found'),
    });
    await setStatus(k3s, "certificate/api-tls", {
      conditions: condition("False", "DoesNotMatch", "Issuing certificate as Secret is not up to date"),
      notAfter: isoIn(DAY_MS),
      renewalTime: isoIn(-3 * DAY_MS),
      failedIssuanceAttempts: 4,
    });

    const res = await h.call("k8s_certificates");
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ total: 1, with_problems: 1 });
    expect(res.json.certificates[0]).toMatchObject({
      name: "api-tls",
      ready: false,
      failed_issuance_attempts: 4,
      issuer: { ref: "Issuer/internal-ca", ready: false },
    });
    expect(res.json.certificates[0].problems.join("\n")).toContain("renewal was due 3 days ago");
  }, 120_000);

  it("never returns the issued key or the token", async () => {
    const res = await h.call("k8s_certificates");
    expect(res.text).not.toContain(TLS_KEY_SECRET);
    expect(res.text).not.toContain(k3s.token);
  });
});
