import { z } from "zod";
import { Level } from "./types.js";

const Env = z.object({
  OPS_PG_URL: z.url(),
  OPS_MAX_LEVEL: z.coerce.number().int().min(1).max(3).default(1),
  /** Comma-separated values to scrub verbatim from all output (app DB password, API keys…). */
  OPS_KNOWN_SECRETS: z.string().default(""),
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
    knownSecrets: [...e.OPS_KNOWN_SECRETS.split(",").map((s) => s.trim()), pgPassword].filter(Boolean) as string[],
  };
}

function safePassword(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}
