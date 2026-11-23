import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentRun, type Outcome, SYSTEM_PROMPT, type ToolCall } from "@ops-agent/watcher/agent";
import { z } from "zod";
import { type Expected, JUDGE_SYSTEM, type Judgement, judgePrompt, Verdict } from "./judge.js";

/** MCP tools appear to Claude Code as mcp__<server>__<tool>. */
const SERVER_NAME = "ops";
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;
const RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * Keys stay out of Claude Code's environment: with ANTHROPIC_API_KEY set it would bill the API instead of the
 * developer's login, and the agent's tools have no business seeing any key.
 */
const WITHHELD_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "DEEPSEEK_API_KEY"];

/** Settings, hooks, CLAUDE.md, other MCP servers and every built-in tool stay off: only our server's tools. */
const ISOLATION = ["--setting-sources", "", "--tools", "", "--strict-mcp-config", "--no-session-persistence"];

interface StreamEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly message?: { readonly content?: ReadonlyArray<Record<string, unknown>> };
  readonly result?: string;
  readonly is_error?: boolean;
  readonly num_turns?: number;
  readonly total_cost_usd?: number;
  readonly usage?: Readonly<Record<string, number>>;
  readonly modelUsage?: Readonly<Record<string, unknown>>;
  readonly structured_output?: unknown;
}

const textOfResult = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { text?: string }) => part.text ?? "").join("\n");
};

function toolCallsOf(events: readonly StreamEvent[]): ToolCall[] {
  const blocks = events.flatMap((event) => event.message?.content ?? []);
  const results = new Map(
    blocks.filter((block) => block.type === "tool_result").map((block) => [block.tool_use_id, block] as const),
  );
  return blocks
    .filter((block) => block.type === "tool_use")
    .map((block) => {
      const result = results.get(block.id);
      const name = String(block.name ?? "");
      return {
        name: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name,
        input: block.input,
        output: textOfResult(result?.content),
        isError: result?.is_error === true,
      };
    });
}

function outcomeOf(result: StreamEvent, maxTurns: number): Outcome {
  if (result.subtype?.includes("budget")) return "cost_limit";
  if (result.is_error) throw new Error(`claude -p failed: ${result.result ?? result.subtype ?? "no message"}`);
  // Claude Code has no turn limit flag; the cost cap stops a runaway run, and turns are checked afterwards.
  if ((result.num_turns ?? 0) > maxTurns) return "turn_limit";
  return "answered";
}

/** Turns Claude Code's stream-json output into a run, the same shape the API backend produces. */
export function parseStream(stdout: string, model: string, maxTurns: number): AgentRun {
  const events = stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as StreamEvent);
  const result = events.findLast((event) => event.type === "result");
  if (!result) throw new Error("claude -p ended without a result");

  const served = Object.keys(result.modelUsage ?? {});
  if (served.some((name) => name !== model)) throw new Error(`asked for ${model}, served by ${served.join(", ")}`);
  const usage = result.usage ?? {};
  const outcome = outcomeOf(result, maxTurns);
  return {
    outcome,
    report: outcome === "answered" ? (result.result ?? "").trim() : "",
    turns: result.num_turns ?? 0,
    toolCalls: toolCallsOf(events),
    costUsd: result.total_cost_usd ?? 0,
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
    transcript: events,
  };
}

function withheldEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !WITHHELD_ENV.includes(name)));
}

/** Runs `claude` in an empty working directory and returns its stdout; fails past a hard wall-clock limit. */
function runClaude(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [...args], { cwd, env: withheldEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      // A failed run still prints its result event; the parser reports it with its reason.
      if (out.includes('"type":"result"')) resolve(out);
      else reject(new Error(`claude exited with ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`));
    });
  });
}

/** A scratch directory for one run, removed afterwards: the MCP config in it holds the lab's passwords. */
async function inScratchDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ops-eval-"));
  try {
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ClaudeCodeAgentOptions {
  readonly model: string;
  readonly symptom: string;
  readonly context: string;
  readonly maxTurns: number;
  readonly maxCostUsd: number;
  /** The built MCP server (dist/src/index.js) and its environment, as production runs it. */
  readonly serverEntry: string;
  readonly serverEnv: Readonly<Record<string, string>>;
}

export function runClaudeCodeAgent(options: ClaudeCodeAgentOptions): Promise<AgentRun> {
  return inScratchDir(async (dir) => {
    const configFile = join(dir, "mcp.json");
    const server = { type: "stdio", command: process.execPath, args: [options.serverEntry], env: options.serverEnv };
    writeFileSync(configFile, JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }));
    const prompt = `${options.context}\n\nIncident report: ${options.symptom}`;
    const stdout = await runClaude(
      [
        "-p",
        prompt,
        ...ISOLATION,
        "--mcp-config",
        configFile,
        "--allowedTools",
        `mcp__${SERVER_NAME}`,
        "--model",
        options.model,
        "--system-prompt",
        SYSTEM_PROMPT,
        "--max-budget-usd",
        String(options.maxCostUsd),
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      dir,
    );
    return parseStream(stdout, options.model, options.maxTurns);
  });
}

// Without the $schema marker: Claude Code's validator does not know the draft Zod names there.
const { $schema: _draft, ...verdictSchema } = z.toJSONSchema(Verdict);
const VERDICT_SCHEMA = JSON.stringify(verdictSchema);

/** The judge on the developer's login, with the same prompt and schema as the API judge. */
export function judgeWithClaudeCode(model: string, expected: Expected, report: string): Promise<Judgement> {
  return inScratchDir(async (dir) => {
    const stdout = await runClaude(
      [
        "-p",
        judgePrompt(expected, report),
        ...ISOLATION,
        "--model",
        model,
        "--system-prompt",
        JUDGE_SYSTEM,
        "--json-schema",
        VERDICT_SCHEMA,
        "--output-format",
        "json",
      ],
      dir,
    );
    const result = JSON.parse(stdout) as StreamEvent;
    if (result.is_error) throw new Error(`judge failed: ${result.result ?? "no message"}`);
    return { verdict: Verdict.parse(result.structured_output), costUsd: result.total_cost_usd ?? 0 };
  });
}
