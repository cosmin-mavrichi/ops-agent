import { z } from "zod";
import { DAY_S, describeSpan, toDays } from "../../lib/units.js";
import { defineTool, Level } from "../../types.js";
import {
  allowedNamespaces,
  type Condition,
  clip,
  conditionOf,
  customResourcePath,
  k8sLabel,
  whenNotInstalled,
} from "./shared.js";

const EXPIRY_WARNING_DAYS = 14;
// cert-manager retries failed issuance with backoff; this long past renewalTime, renewal is failing, not slow.
const RENEWAL_GRACE_S = 60 * 60;
const MAX_DNS_NAMES = 5;

/**
 * Only the fields the tool reads. The issued private key lives in the Secret `spec.secretName`, which the
 * ops ServiceAccount cannot read.
 */
export interface Certificate {
  readonly metadata?: { readonly name?: string; readonly namespace?: string };
  readonly spec?: {
    readonly dnsNames?: readonly string[];
    readonly issuerRef?: { readonly name?: string; readonly kind?: string };
  };
  readonly status?: {
    readonly conditions?: readonly Condition[];
    readonly notAfter?: string;
    readonly renewalTime?: string;
    readonly failedIssuanceAttempts?: number;
  };
}

export interface Issuer {
  readonly metadata?: { readonly name?: string; readonly namespace?: string };
  readonly status?: { readonly conditions?: readonly Condition[] };
}

interface IssuerState {
  readonly ref: string;
  /** null for a ClusterIssuer: cluster-scoped, outside the namespaces the agent may read. */
  readonly ready: boolean | null;
  readonly message: string | null;
}

export interface CertificateSummary {
  readonly namespace: string;
  readonly name: string;
  readonly ready: boolean | null;
  readonly reason: string | null;
  readonly message: string | null;
  readonly dns_names: readonly string[];
  readonly issuer: IssuerState;
  /** null before the first issuance. */
  readonly not_after: string | null;
  /** Negative once expired; rounded, so a certificate with hours left shows 0 (see `problems`). */
  readonly expires_in_days: number | null;
  readonly renewal_overdue_s: number | null;
  readonly failed_issuance_attempts: number;
  readonly problems: readonly string[];
}

const issuerKey = (namespace: string, name: string | undefined) => `${namespace}/${name}`;

const secondsUntil = (iso: string, now: Date) => (Date.parse(iso) - now.getTime()) / 1000;

function issuerState(cert: Certificate, issuers: ReadonlyMap<string, Issuer>): IssuerState {
  const kind = cert.spec?.issuerRef?.kind ?? "Issuer";
  const name = cert.spec?.issuerRef?.name;
  const ref = `${kind}/${name}`;
  if (kind !== "Issuer") return { ref, ready: null, message: null };

  const issuer = issuers.get(issuerKey(cert.metadata?.namespace ?? "", name));
  if (issuer === undefined) return { ref, ready: false, message: "the issuer does not exist" };
  const ready = conditionOf(issuer.status?.conditions, "Ready");
  return { ref, ready: ready?.status === "True", message: clip(ready?.message) ?? null };
}

function renewalOverdue(renewalTime: string | undefined, now: Date): number | null {
  if (!renewalTime) return null;
  const overdue = -secondsUntil(renewalTime, now);
  return overdue > RENEWAL_GRACE_S ? Math.round(overdue) : null;
}

type ReadyState = Pick<CertificateSummary, "ready" | "reason" | "message" | "issuer">;

/** Unrounded, so that the problems don't depend on how the output rounds days. */
interface Timing {
  readonly secondsLeft: number | null;
  readonly overdueS: number | null;
}

/**
 * A broken issuer blocks every request, whatever the certificate's own reason says (e.g. RequestChanged after a
 * DNS name change only means a new request is due). Saying so keeps the model from reporting two causes.
 */
function notReadyProblem({ reason, message, issuer }: ReadyState): string {
  const own = `not Ready (${reason ?? "no reason"}): ${message ?? "no message"}`;
  if (issuer.ready !== false) return own;
  return `${own}; it cannot be issued until its issuer ${issuer.ref} is Ready`;
}

/** The conclusions an operator would draw first, spelled out so the model doesn't have to. */
function problemsOf(state: ReadyState, timing: Timing): string[] {
  const { ready, issuer } = state;
  const { secondsLeft, overdueS } = timing;
  const expired = secondsLeft !== null && secondsLeft <= 0;
  const expiresSoon = secondsLeft !== null && !expired && secondsLeft < EXPIRY_WARNING_DAYS * DAY_S;
  const problems: string[] = [];

  if (expired) problems.push(`expired ${describeSpan(-secondsLeft)} ago`);
  if (expiresSoon) problems.push(`expires in ${describeSpan(secondsLeft)}`);
  if (ready === false) problems.push(notReadyProblem(state));
  if (overdueS !== null) problems.push(`renewal was due ${describeSpan(overdueS)} ago and has not happened`);
  if (issuer.ready === false) {
    problems.push(
      `its issuer ${issuer.ref} is not Ready, which blocks issuing and renewing it: ${issuer.message ?? "no message"}`,
    );
  }

  return problems;
}

export function summarizeCertificate(
  cert: Certificate,
  issuers: ReadonlyMap<string, Issuer>,
  now: Date,
): CertificateSummary {
  const ready = conditionOf(cert.status?.conditions, "Ready");
  const notAfter = cert.status?.notAfter;
  const secondsLeft = notAfter ? secondsUntil(notAfter, now) : null;
  const overdueS = renewalOverdue(cert.status?.renewalTime, now);
  const state: ReadyState = {
    ready: ready === undefined ? null : ready.status === "True",
    reason: ready?.reason ?? null,
    message: clip(ready?.message) ?? null,
    issuer: issuerState(cert, issuers),
  };
  const expiresInDays = secondsLeft === null ? null : toDays(secondsLeft);
  return {
    namespace: cert.metadata?.namespace ?? "",
    name: cert.metadata?.name ?? "",
    ...state,
    dns_names: (cert.spec?.dnsNames ?? []).slice(0, MAX_DNS_NAMES),
    not_after: notAfter ?? null,
    expires_in_days: expiresInDays,
    renewal_overdue_s: overdueS,
    failed_issuance_attempts: cert.status?.failedIssuanceAttempts ?? 0,
    problems: problemsOf(state, { secondsLeft, overdueS }),
  };
}

const NEVER_ISSUED_LAST = Number.POSITIVE_INFINITY;
const mostProblemsThenSoonestExpiry = (a: CertificateSummary, b: CertificateSummary) =>
  b.problems.length - a.problems.length ||
  (a.expires_in_days ?? NEVER_ISSUED_LAST) - (b.expires_in_days ?? NEVER_ISSUED_LAST);

export function summarizeCertificates(certs: readonly Certificate[], issuers: readonly Issuer[], now: Date) {
  const byKey = new Map(
    issuers.map((issuer) => [issuerKey(issuer.metadata?.namespace ?? "", issuer.metadata?.name), issuer]),
  );
  const summaries = certs.map((cert) => summarizeCertificate(cert, byKey, now));
  return summaries.toSorted(mostProblemsThenSoonestExpiry);
}

const CERT_MANAGER_API = "cert-manager.io/v1";
const NOT_INSTALLED =
  "cert-manager is not installed in this cluster (there is no cert-manager.io/v1 API), so there are no " +
  "Certificates to inspect. TLS certificates managed another way are not visible to this tool.";

export const k8sCertificates = defineTool({
  name: "k8s_certificates",
  level: Level.Read,
  requires: ["k8s"],
  title: "Kubernetes: TLS certificates (cert-manager)",
  description:
    "cert-manager Certificates in the allowed namespaces: Ready or not and why, days until expiry, whether " +
    "renewal is overdue, failed issuance attempts, and whether the namespaced Issuer that signs it is Ready. " +
    "`problems` lists what needs attention, and certificates with problems come first. Use when clients report " +
    "TLS or certificate errors, or to check that renewals are working. ClusterIssuers are cluster-scoped and " +
    "not inspected. Never returns keys or certificate data.",
  input: {
    namespace: k8sLabel.optional(),
    limit: z.number().int().min(1).max(50).default(30),
  },
  timeoutMs: 8_000,

  async run({ namespace, limit }, { k8s, signal }) {
    const list = <T>(ns: string, plural: "certificates" | "issuers") =>
      k8s.getJson<{ items: T[] }>(customResourcePath(CERT_MANAGER_API, ns, plural), signal).then((r) => r.items);
    const listNamespace = (ns: string) =>
      Promise.all([list<Certificate>(ns, "certificates"), list<Issuer>(ns, "issuers")]);

    const namespaces = allowedNamespaces(k8s, namespace);
    const perNamespace = await Promise.all(namespaces.map(listNamespace)).catch(whenNotInstalled(NOT_INSTALLED));

    const certs = perNamespace.flatMap(([namespaceCerts]) => namespaceCerts);
    const issuers = perNamespace.flatMap(([, namespaceIssuers]) => namespaceIssuers);
    const summaries = summarizeCertificates(certs, issuers, new Date());
    return {
      total: summaries.length,
      with_problems: summaries.filter((summary) => summary.problems.length > 0).length,
      certificates: summaries.slice(0, limit),
    };
  },
});
