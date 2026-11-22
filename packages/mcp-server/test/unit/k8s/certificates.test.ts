import { describe, expect, it } from "vitest";
import {
  type Certificate,
  type Issuer,
  k8sCertificates,
  summarizeCertificates,
} from "../../../src/tools/k8s/certificates.js";
import { ToolError } from "../../../src/types.js";
import { useHarness } from "../../harness.js";
import { ago, fakeK8s, NOW } from "./fake-k8s.js";

const harness = useHarness();

const ANNOTATION_SECRET = "planted-annotation-token-3391";
const DAY_S = 86_400;
const fromNow = (seconds: number) => ago(-seconds);

const ready = (status: "True" | "False", reason: string, message: string) => ({
  conditions: [{ type: "Ready", status, reason, message }],
});

const healthy: Certificate = {
  metadata: { name: "web-tls", namespace: "app" },
  spec: { dnsNames: ["shop.example.test"], issuerRef: { name: "letsencrypt", kind: "ClusterIssuer" } },
  status: {
    ...ready("True", "Ready", "Certificate is up to date"),
    notAfter: fromNow(60 * DAY_S),
    renewalTime: fromNow(30 * DAY_S),
  },
};

// The incident: the CA issuer lost its key, renewal is days overdue and the certificate expires tomorrow.
// Not typed as Certificate: like a real API reply, it carries fields the tool must ignore.
const failing = {
  metadata: {
    name: "api-tls",
    namespace: "app",
    annotations: { "kubectl.kubernetes.io/last-applied-configuration": `{"token":"${ANNOTATION_SECRET}"}` },
  },
  spec: { dnsNames: ["api.example.test"], issuerRef: { name: "internal-ca", kind: "Issuer" }, secretName: "api-tls" },
  status: {
    ...ready("False", "DoesNotMatch", "Issuing certificate as Secret is not up to date"),
    notAfter: fromNow(DAY_S),
    renewalTime: fromNow(-3 * DAY_S),
    failedIssuanceAttempts: 4,
  },
};

const brokenIssuer: Issuer = {
  metadata: { name: "internal-ca", namespace: "app" },
  status: ready("False", "ErrGetKeyPair", 'Error getting keypair for CA issuer: secret "ca-key" not found'),
};

describe("summarizeCertificates", () => {
  const [first, second] = summarizeCertificates([healthy, failing], [brokenIssuer], NOW);

  it("puts the certificate with problems first and spells them out", () => {
    expect(first).toMatchObject({
      name: "api-tls",
      ready: false,
      expires_in_days: 1,
      renewal_overdue_s: 3 * DAY_S,
      failed_issuance_attempts: 4,
      issuer: { ref: "Issuer/internal-ca", ready: false },
    });
    expect(first?.problems).toEqual([
      "expires in 1 day",
      "not Ready (DoesNotMatch): Issuing certificate as Secret is not up to date",
      "renewal was due 3 days ago and has not happened",
      'its issuer Issuer/internal-ca is not Ready: Error getting keypair for CA issuer: secret "ca-key" not found',
    ]);
  });

  it("reports nothing for a healthy certificate, and does not judge a ClusterIssuer it cannot read", () => {
    expect(second).toMatchObject({ name: "web-tls", ready: true, expires_in_days: 60, renewal_overdue_s: null });
    expect(second?.issuer).toEqual({ ref: "ClusterIssuer/letsencrypt", ready: null, message: null });
    expect(second?.problems).toEqual([]);
  });

  it("flags an expired certificate and an Issuer that does not exist", () => {
    const expired = { ...failing, status: { notAfter: fromNow(-2 * DAY_S) } };
    const [summary] = summarizeCertificates([expired], [], NOW);
    expect(summary?.problems).toEqual([
      "expired 2 days ago",
      "its issuer Issuer/internal-ca is not Ready: the issuer does not exist",
    ]);
  });

  it("counts a certificate with an hour left in hours, not as expired", () => {
    const shortLived = { ...healthy, status: { ...healthy.status, notAfter: fromNow(3_600) } };
    const [summary] = summarizeCertificates([shortLived], [], NOW);
    expect(summary?.problems).toEqual(["expires in 1 hour"]);
  });

  it("treats a certificate that was never issued as unknown expiry, not expired", () => {
    const pending = { metadata: { name: "new-tls", namespace: "app" }, spec: { issuerRef: { kind: "ClusterIssuer" } } };
    const [summary] = summarizeCertificates([pending], [], NOW);
    expect(summary).toMatchObject({ expires_in_days: null, ready: null, problems: [] });
  });
});

describe("k8s_certificates (unit)", () => {
  it("reads Certificates and Issuers of the allowed namespaces, never their Secrets or annotations", async () => {
    const k8s = fakeK8s({ "/certificates": { items: [healthy, failing] }, "/issuers": { items: [brokenIssuer] } }, [
      "app",
    ]);
    const h = await harness({ tools: [k8sCertificates], k8s: k8s.client });
    const res = await h.call("k8s_certificates");

    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ total: 2, with_problems: 1 });
    expect(k8s.calls.map((call) => call.path).sort()).toEqual([
      "/apis/cert-manager.io/v1/namespaces/app/certificates",
      "/apis/cert-manager.io/v1/namespaces/app/issuers",
    ]);
    expect(res.text).not.toContain(ANNOTATION_SECRET);
  });

  it("refuses a namespace outside the allowlist before calling the API", async () => {
    const k8s = fakeK8s({}, ["app"]);
    const h = await harness({ tools: [k8sCertificates], k8s: k8s.client });
    const res = await h.call("k8s_certificates", { namespace: "kube-system" });
    expect(res.json.error).toBe("forbidden_namespace");
    expect(k8s.calls).toEqual([]);
  });

  it("says cert-manager is not installed when its API does not exist", async () => {
    const notFound = () => {
      throw new ToolError("not_found", "/apis/cert-manager.io/v1/namespaces/app/certificates does not exist");
    };
    const k8s = fakeK8s({ "/certificates": notFound }, ["app"]);
    const h = await harness({ tools: [k8sCertificates], k8s: k8s.client });
    const res = await h.call("k8s_certificates");
    expect(res.isError).toBe(true);
    expect(res.json.error).toBe("unavailable");
    expect(res.json.message).toContain("cert-manager is not installed");
  });
});
