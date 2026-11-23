import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@modelcontextprotocol/client";
import type { Lab, Scenario } from "../lab/scenario.js";
import { type AgentRun, runAgent, type ToolServer } from "./agent.js";
import { judgeWithClaudeCode, runClaudeCodeAgent } from "./claude-code.js";
import type { EvalConfig } from "./config.js";
import { type Judgement, judge } from "./judge.js";

/** The real server, built by `pnpm eval` before the run (tsc -p .), for the claude-code backend. */
const SERVER_ENTRY = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));

const toAnthropicTool = (tool: Tool): Anthropic.Tool => ({
  name: tool.name,
  description: tool.description ?? "",
  input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
});

/** DeepSeek answers with its own version name (e.g. DeepSeek-V4.1-Flash-1017), not the alias asked for. */
const isDeepSeek = (served: string) => served.toLowerCase().startsWith("deepseek");

/**
 * Lab artifacts the agent would otherwise blame: every service was started for the scenario (uptimes are seconds,
 * which reads like a restart), and every workload runs a placeholder busybox image (which reads like a wrong
 * build). No scenario is about either.
 */
const LAB_NOTE =
  "This is a test environment: every service was started a few minutes ago, so short uptimes are expected " +
  "and are not a sign of a restart, and workloads run placeholder busybox images on purpose. This covers " +
  "uptimes and images only: backups, queues, data and everything else are part of the incident as you find them.";

/** What the operator would tell the agent: the namespaces it may inspect, and what is normal here. */
const contextOf = (lab: Lab) =>
  `Kubernetes namespaces you may inspect: ${lab.k3s.ops.namespaces.join(", ")}.\n${LAB_NOTE}`;

export function diagnose(
  config: EvalConfig,
  lab: Lab,
  scenario: Scenario,
  mcpTools: readonly Tool[],
): Promise<AgentRun> {
  const common = {
    model: config.model,
    symptom: scenario.symptom,
    context: contextOf(lab),
    maxTurns: config.maxTurns,
    maxCostUsd: config.maxCostUsd,
  };
  if (!config.client) {
    return runClaudeCodeAgent({ ...common, serverEntry: SERVER_ENTRY, serverEnv: lab.serverEnv });
  }
  const tools: ToolServer = {
    listTools: async () => mcpTools.map(toAnthropicTool),
    call: (name, input) => lab.call(name, input),
  };
  const isExpectedModel = config.backend === "deepseek" ? isDeepSeek : undefined;
  return runAgent({ ...common, client: config.client, tools, isExpectedModel });
}

export function grade(config: EvalConfig, scenario: Scenario, report: string): Promise<Judgement> {
  if (!config.client) return judgeWithClaudeCode(config.judgeModel, scenario, report);
  return judge(config.client, config.judgeModel, scenario, report);
}
