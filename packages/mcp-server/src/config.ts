import { z } from "zod";
import { Level } from "./types.js";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

const Env = z.object({
  OPS_PG_URL: z.url(),
  OPS_MAX_LEVEL: z.coerce.number().int().min(1).max(3).default(1),
  /** Comma-separated values to scrub verbatim from all output (app DB password, API keys…). */
  OPS_KNOWN_SECRETS: z.string().default(""),
  /** Directory with one secret value per file (a mounted Kubernetes Secret), scrubbed like OPS_KNOWN_SECRETS. */
  OPS_KNOWN_SECRETS_DIR: z.string().min(1).optional(),
  /** Comma-separated namespaces the agent may inspect. Unset = no Kubernetes tools. */
  OPS_K8S_NAMESPACES: z.string().default(""),
  /** Out-of-cluster overrides; in a pod the defaults come from the mounted ServiceAccount. */
  OPS_K8S_SERVER: z.url().optional(),
  OPS_K8S_TOKEN_FILE: z.string().default(`${SA_DIR}/token`),
  OPS_K8S_CA_FILE: z.string().default(`${SA_DIR}/ca.crt`),
  KUBERNETES_SERVICE_HOST: z.string().optional(),
  KUBERNETES_SERVICE_PORT: z.string().default("443"),
  /** Redis URL with the ops_ro ACL user, e.g. redis://ops_ro:pw@redis:6379. Unset = no Redis tools. */
  OPS_REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
  /** Prometheus-compatible query API, e.g. http://prometheus.monitoring:9090. Unset = no metrics tools. */
  OPS_PROM_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** OpenSearch or Elasticsearch URL as the ops_ro user. Unset = no search tools. */
  OPS_SEARCH_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** PEM CA bundle for a search cluster with a self-signed certificate. */
  OPS_SEARCH_CA_FILE: z.string().min(1).optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const vars = Env.parse(env);
  if (vars.OPS_MAX_LEVEL > Level.Read) {
    // v1 guard: refuse to boot with write tools until v2 adds approvals.
    throw new Error("OPS_MAX_LEVEL > 1 is not supported in v1");
  }
  const urlPasswords = [vars.OPS_PG_URL, vars.OPS_REDIS_URL, vars.OPS_PROM_URL, vars.OPS_SEARCH_URL]
    .map(passwordIn)
    .filter((pw) => pw !== undefined);
  return {
    pgUrl: vars.OPS_PG_URL,
    redisUrl: vars.OPS_REDIS_URL,
    promUrl: vars.OPS_PROM_URL,
    search: searchConfig(vars),
    maxLevel: vars.OPS_MAX_LEVEL as Level,
    knownSecrets: [...splitList(vars.OPS_KNOWN_SECRETS), ...urlPasswords],
    knownSecretsDir: vars.OPS_KNOWN_SECRETS_DIR,
    k8s: k8sConfig(vars),
  };
}

export type K8sSettings = NonNullable<ReturnType<typeof k8sConfig>>;
export type SearchSettings = NonNullable<ReturnType<typeof searchConfig>>;

function k8sConfig(vars: z.infer<typeof Env>) {
  const namespaces = splitList(vars.OPS_K8S_NAMESPACES);
  if (namespaces.length === 0) return undefined;

  const inCluster = vars.KUBERNETES_SERVICE_HOST
    ? `https://${vars.KUBERNETES_SERVICE_HOST}:${vars.KUBERNETES_SERVICE_PORT}`
    : undefined;
  const server = vars.OPS_K8S_SERVER ?? inCluster;
  if (!server) {
    throw new Error("OPS_K8S_NAMESPACES is set but there is no API server: set OPS_K8S_SERVER or run in a pod");
  }
  return { server, namespaces, tokenFile: vars.OPS_K8S_TOKEN_FILE, caFile: vars.OPS_K8S_CA_FILE };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function passwordIn(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}

function searchConfig(vars: z.infer<typeof Env>) {
  if (!vars.OPS_SEARCH_URL) return undefined;
  return { url: vars.OPS_SEARCH_URL, caFile: vars.OPS_SEARCH_CA_FILE };
}
