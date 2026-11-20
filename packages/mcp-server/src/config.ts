import { z } from "zod";
import { Level } from "./types.js";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

const Env = z.object({
  OPS_PG_URL: z.url(),
  OPS_MAX_LEVEL: z.coerce.number().int().min(1).max(3).default(1),
  /** Comma-separated values to scrub verbatim from all output (app DB password, API keys…). */
  OPS_KNOWN_SECRETS: z.string().default(""),
  /** Comma-separated namespaces the agent may inspect. Unset = no Kubernetes tools. */
  OPS_K8S_NAMESPACES: z.string().default(""),
  /** Out-of-cluster overrides; in a pod the defaults come from the mounted ServiceAccount. */
  OPS_K8S_SERVER: z.url().optional(),
  OPS_K8S_TOKEN_FILE: z.string().default(`${SA_DIR}/token`),
  OPS_K8S_CA_FILE: z.string().default(`${SA_DIR}/ca.crt`),
  KUBERNETES_SERVICE_HOST: z.string().optional(),
  KUBERNETES_SERVICE_PORT: z.string().default("443"),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Env.parse(env);
  if (e.OPS_MAX_LEVEL > Level.Read) {
    // v1 guard: refuse to boot with write tools until v2 adds approvals.
    throw new Error("OPS_MAX_LEVEL > 1 is not supported in v1");
  }
  const pgPassword = safePassword(e.OPS_PG_URL);
  return {
    pgUrl: e.OPS_PG_URL,
    maxLevel: e.OPS_MAX_LEVEL as Level,
    knownSecrets: [...splitList(e.OPS_KNOWN_SECRETS), pgPassword].filter(Boolean) as string[],
    k8s: k8sConfig(e),
  };
}

function k8sConfig(e: z.infer<typeof Env>) {
  const namespaces = splitList(e.OPS_K8S_NAMESPACES);
  if (namespaces.length === 0) return undefined;
  const inCluster = e.KUBERNETES_SERVICE_HOST
    ? `https://${e.KUBERNETES_SERVICE_HOST}:${e.KUBERNETES_SERVICE_PORT}`
    : undefined;
  const server = e.OPS_K8S_SERVER ?? inCluster;
  if (!server)
    throw new Error("OPS_K8S_NAMESPACES is set but there is no API server: set OPS_K8S_SERVER or run in a pod");
  return { server, namespaces, tokenFile: e.OPS_K8S_TOKEN_FILE, caFile: e.OPS_K8S_CA_FILE };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function safePassword(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}
