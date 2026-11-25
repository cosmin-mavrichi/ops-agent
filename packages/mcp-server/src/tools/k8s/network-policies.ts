// A manager's update lands a moment after creation; closer than this to it is the creation itself.
const CREATE_SKEW_MS = 5_000;
// Per direction: a long allowlist says little more than its first rules, and costs tokens in every call.
const MAX_RULES = 5;

type Labels = Readonly<Record<string, string>>;

interface Selector {
  readonly matchLabels?: Labels;
  readonly matchExpressions?: readonly unknown[];
}

interface Peer {
  readonly podSelector?: Selector;
  readonly namespaceSelector?: Selector;
  readonly ipBlock?: { readonly cidr: string; readonly except?: readonly string[] };
}

interface Port {
  readonly protocol?: string;
  readonly port?: number | string;
}

interface Rule {
  readonly from?: readonly Peer[];
  readonly to?: readonly Peer[];
  readonly ports?: readonly Port[];
}

/** The fields a policy's summary reads; managedFields only for their times, never the field sets. */
export interface NetworkPolicy {
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly creationTimestamp?: string;
    readonly managedFields?: ReadonlyArray<{ readonly time?: string }>;
  };
  readonly spec?: {
    readonly podSelector?: Selector;
    readonly policyTypes?: readonly string[];
    readonly ingress?: readonly Rule[];
    readonly egress?: readonly Rule[];
  };
}

export interface PolicyChange {
  readonly namespace: string;
  readonly name: string;
  /** Epoch milliseconds of the last create or update. */
  readonly at: number;
  readonly change: string;
}

type Direction = "Ingress" | "Egress";

function describeSelector(selector: Selector | undefined, everything: string): string {
  const labels = Object.entries(selector?.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`);
  const expressions = selector?.matchExpressions?.length ?? 0;
  const counted = `${expressions} label expression${expressions === 1 ? "" : "s"}`;
  const parts = expressions > 0 ? [...labels, counted] : labels;
  return parts.length > 0 ? parts.join(",") : everything;
}

function describePeer(peer: Peer): string {
  if (peer.ipBlock) {
    const except = peer.ipBlock.except?.length ? ` except ${peer.ipBlock.except.join(", ")}` : "";
    return `${peer.ipBlock.cidr}${except}`;
  }
  const pods = `pods ${describeSelector(peer.podSelector, "(any)")}`;
  if (!peer.namespaceSelector) return pods;
  return `${pods} in namespaces ${describeSelector(peer.namespaceSelector, "(any)")}`;
}

const describePort = (port: Port) => `${port.protocol ?? "TCP"} ${port.port ?? "(any port)"}`;

function describeRule(rule: Rule, direction: Direction): string {
  const peers = (direction === "Ingress" ? rule.from : rule.to) ?? [];
  const who = peers.length > 0 ? peers.map(describePeer).join(" or ") : "anywhere";
  const ports = rule.ports?.length ? ` on ${rule.ports.map(describePort).join(", ")}` : "";
  return `${direction === "Ingress" ? "from" : "to"} ${who}${ports}`;
}

/** Without policyTypes, a policy restricts ingress, and egress only when it has egress rules. */
function directionsOf(policy: NetworkPolicy): readonly Direction[] {
  const types = policy.spec?.policyTypes;
  if (types !== undefined) return types.filter((type): type is Direction => type === "Ingress" || type === "Egress");
  return policy.spec?.egress === undefined ? ["Ingress"] : ["Ingress", "Egress"];
}

function describeDirection(policy: NetworkPolicy, direction: Direction): string {
  const rules = (direction === "Ingress" ? policy.spec?.ingress : policy.spec?.egress) ?? [];
  const name = direction.toLowerCase();
  if (rules.length === 0) return `all ${name} denied`;
  const shown = rules.slice(0, MAX_RULES).map((rule) => describeRule(rule, direction));
  const hidden = rules.length - shown.length;
  const more = hidden > 0 ? `; and ${hidden} more rules` : "";
  return `${name} allowed only ${shown.join("; ")}${more}`;
}

/** What the policy does now, e.g. `pods app=api: ingress allowed only from pods app=web on TCP 8080`. */
export function describePolicy(policy: NetworkPolicy): string {
  const pods = describeSelector(policy.spec?.podSelector, "every pod in the namespace");
  const effects = directionsOf(policy).map((direction) => describeDirection(policy, direction));
  return `${pods}: ${effects.join("; ")}`;
}

function lastWrite(policy: NetworkPolicy): { readonly at: number; readonly created: number } {
  const created = Date.parse(policy.metadata.creationTimestamp ?? "");
  const writes = (policy.metadata.managedFields ?? []).map((entry) => Date.parse(entry.time ?? ""));
  const known = [created, ...writes].filter((time) => !Number.isNaN(time));
  // With no time at all this is -Infinity, which every window leaves out.
  return { at: Math.max(...known), created };
}

/**
 * The policy's last create or update. The API keeps no history, so an update says what the policy does now, not
 * what it did before; a deleted policy leaves nothing to read.
 */
export function policyChange(policy: NetworkPolicy): PolicyChange {
  const { at, created } = lastWrite(policy);
  const verb = at - created > CREATE_SKEW_MS ? "changed" : "created";
  return {
    namespace: policy.metadata.namespace,
    name: policy.metadata.name,
    at,
    change: `${verb}; now applies to ${describePolicy(policy)}`,
  };
}
