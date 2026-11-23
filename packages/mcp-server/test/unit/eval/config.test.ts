import { describe, expect, it } from "vitest";
import { parseStream } from "../../../eval/claude-code.js";
import { loadEvalConfig } from "../../../eval/config.js";

const KEY = "sk-ant-planted-key-0042";

describe("loadEvalConfig", () => {
  it("refuses to run in CI", () => {
    expect(() => loadEvalConfig({ CI: "true", SCENARIO: "crash-loop" })).toThrow("do not run in CI");
  });

  it("refuses to run every scenario unless asked to", () => {
    expect(() => loadEvalConfig({})).toThrow("name the scenarios");
    expect(loadEvalConfig({ EVAL_ALL: "1" }).scenarios).toBeUndefined();
  });

  it("defaults to the developer's own Claude Code login, with Haiku 5.5 as agent and judge", () => {
    expect(loadEvalConfig({ SCENARIO: "crash-loop" })).toMatchObject({
      backend: "claude-code",
      model: "claude-haiku-5-5",
      judgeModel: "claude-haiku-5-5",
      client: undefined,
    });
  });

  it("uses deepseek-flash on DeepSeek", () => {
    const config = loadEvalConfig({ SCENARIO: "a", EVAL_BACKEND: "deepseek", DEEPSEEK_API_KEY: KEY });
    expect(config).toMatchObject({ model: "deepseek-flash", judgeModel: "deepseek-flash" });
    expect(config.client).toBeDefined();
  });

  it("names a missing key without printing any value", () => {
    const err = (() => {
      try {
        loadEvalConfig({ SCENARIO: "a", EVAL_BACKEND: "anthropic", DEEPSEEK_API_KEY: KEY });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toContain("ANTHROPIC_API_KEY is not set");
    expect(err?.message).not.toContain(KEY);
  });

  it("rejects an unknown backend", () => {
    expect(() => loadEvalConfig({ SCENARIO: "a", EVAL_BACKEND: "gpt" })).toThrow("must be one of");
  });
});

const line = (event: object) => JSON.stringify(event);

/** What `claude -p --output-format stream-json` prints for one tool call and an answer. */
const STREAM = [
  line({ type: "system", subtype: "init", tools: ["mcp__ops__k8s_pods"] }),
  line({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "mcp__ops__k8s_pods", input: { namespace: "app" } }] },
  }),
  line({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"pods":[]}' }] }],
    },
  }),
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Root cause: worker crash-loops.",
    num_turns: 2,
    total_cost_usd: 0.004,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
    modelUsage: { "claude-haiku-5-5": {} },
  }),
].join("\n");

describe("parseStream", () => {
  it("reads the report, the tool calls without their prefix, cost and usage", () => {
    const run = parseStream(STREAM, "claude-haiku-5-5", 15);
    expect(run).toMatchObject({
      outcome: "answered",
      report: "Root cause: worker crash-loops.",
      turns: 2,
      costUsd: 0.004,
    });
    expect(run.toolCalls).toEqual([
      { name: "k8s_pods", input: { namespace: "app" }, output: '{"pods":[]}', isError: false },
    ]);
    expect(run.usage).toEqual({ input: 10, output: 20, cacheRead: 300, cacheWrite: 40 });
  });

  it("keeps a built-in tool's name, so the guardrail check sees it", () => {
    const withBash = STREAM.replaceAll("mcp__ops__k8s_pods", "Bash");
    expect(parseStream(withBash, "claude-haiku-5-5", 15).toolCalls[0]?.name).toBe("Bash");
  });

  it("marks a run that hit the budget or went past the turn limit", () => {
    const overBudget = STREAM.replace(
      '"subtype":"success","is_error":false',
      '"subtype":"error_max_budget_usd","is_error":true',
    );
    expect(parseStream(overBudget, "claude-haiku-5-5", 15).outcome).toBe("cost_limit");
    expect(parseStream(STREAM, "claude-haiku-5-5", 1).outcome).toBe("turn_limit");
  });

  it("fails on a model other than the one asked for, and on a login error", () => {
    expect(() => parseStream(STREAM, "claude-opus-5-5", 15)).toThrow("served by claude-haiku-5-5");
    const notLoggedIn = STREAM.replace(
      '"is_error":false,"result":"Root cause: worker crash-loops."',
      '"is_error":true,"result":"Not logged in"',
    );
    expect(() => parseStream(notLoggedIn, "claude-haiku-5-5", 15)).toThrow("Not logged in");
  });
});
