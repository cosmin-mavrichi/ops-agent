import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Where the agent and the judge run:
 *  - claude-code: headless Claude Code (`claude -p`) on the developer's own login (subscription); no key needed,
 *  - anthropic: the Claude API, with ANTHROPIC_API_KEY,
 *  - deepseek: DeepSeek's Anthropic-format API, with DEEPSEEK_API_KEY.
 */
export const BACKENDS = ["claude-code", "anthropic", "deepseek"] as const;
export type Backend = (typeof BACKENDS)[number];

const DEFAULT_MODELS: Readonly<Record<Backend, string>> = {
  "claude-code": "claude-haiku-5-5",
  anthropic: "claude-haiku-5-5",
  deepseek: "deepseek-flash",
};

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic";

export interface EvalConfig {
  readonly backend: Backend;
  readonly model: string;
  readonly judgeModel: string;
  /** Comma-separated scenario names; undefined only when EVAL_ALL=1 asked for every scenario. */
  readonly scenarios: string | undefined;
  readonly maxTurns: number;
  readonly maxCostUsd: number;
  /** For the API backends; undefined for claude-code, which uses the developer's own login. */
  readonly client: Anthropic | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The repo's .env (gitignored) may hold the keys, so they never have to be typed into a shell or a command. */
export function loadDotEnv(file: URL): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

/**
 * Evals spend money, so they never run in CI and never run every scenario by accident: name the scenarios in
 * SCENARIO, or set EVAL_ALL=1 for a full pass.
 */
export function loadEvalConfig(env: Env): EvalConfig {
  if (env.CI) throw new Error("agent evals cost money and do not run in CI");
  if (!env.SCENARIO && env.EVAL_ALL !== "1") {
    throw new Error("name the scenarios to run: SCENARIO=crash-loop pnpm eval (a full pass needs EVAL_ALL=1)");
  }
  const backend = parseBackend(env.EVAL_BACKEND);
  const model = env.EVAL_MODEL || DEFAULT_MODELS[backend];
  return {
    backend,
    model,
    judgeModel: env.EVAL_JUDGE_MODEL || model,
    scenarios: env.SCENARIO || undefined,
    maxTurns: 15,
    maxCostUsd: 0.25,
    client: clientFor(backend, env),
  };
}

function parseBackend(value: string | undefined): Backend {
  const backend = value || "claude-code";
  if (!(BACKENDS as readonly string[]).includes(backend)) {
    throw new Error(`EVAL_BACKEND must be one of ${BACKENDS.join(", ")}, not "${backend}"`);
  }
  return backend as Backend;
}

/** Errors name the missing variable, never a value. */
function clientFor(backend: Backend, env: Env): Anthropic | undefined {
  if (backend === "claude-code") return undefined;
  if (backend === "anthropic") return new Anthropic({ apiKey: required(env, "ANTHROPIC_API_KEY") });
  return new Anthropic({ apiKey: required(env, "DEEPSEEK_API_KEY"), baseURL: DEEPSEEK_BASE_URL });
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set; add it to the repo's .env (see .env.example)`);
  return value;
}
