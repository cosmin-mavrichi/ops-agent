import { Level, splitList } from "@ops-agent/mcp-server/shared";
import { z } from "zod";

const Env = z.object({
  /** Comma-separated namespaces the write server may act in; ops-write's Role grants the same set. */
  OPS_K8S_NAMESPACES: z.string().default(""),
  // No in-cluster defaults: v2.0 runs the write server only next to an interactive client, never in a pod.
  OPS_K8S_SERVER: z.url({ protocol: /^https$/ }),
  /** A short-lived ops-write token, made per session: kubectl create token ops-write -n ops --duration=1h */
  OPS_K8S_TOKEN_FILE: z.string().min(1),
  OPS_K8S_CA_FILE: z.string().min(1),
  OPS_MAX_LEVEL: z.coerce.number().pipe(z.enum(Level)).default(Level.Change),
  /** Comma-separated values to scrub verbatim from all output and forms, as on the read server. */
  OPS_KNOWN_SECRETS: z.string().default(""),
  OPS_KNOWN_SECRETS_DIR: z.string().min(1).optional(),
});

export type WriteConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const vars = Env.parse(env);
  if (vars.OPS_MAX_LEVEL > Level.Change) {
    throw new Error("OPS_MAX_LEVEL 3 (dangerous) is not supported: no dangerous tool exists yet");
  }
  const namespaces = splitList(vars.OPS_K8S_NAMESPACES);
  if (namespaces.length === 0) {
    throw new Error("OPS_K8S_NAMESPACES is required: the namespaces the write server may act in");
  }
  return {
    k8s: {
      server: vars.OPS_K8S_SERVER,
      tokenFile: vars.OPS_K8S_TOKEN_FILE,
      caFile: vars.OPS_K8S_CA_FILE,
      namespaces,
    },
    maxLevel: vars.OPS_MAX_LEVEL,
    knownSecrets: splitList(vars.OPS_KNOWN_SECRETS),
    knownSecretsDir: vars.OPS_KNOWN_SECRETS_DIR,
  };
}
