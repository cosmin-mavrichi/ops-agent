import { describe, expect, it } from "vitest";
import { assertBackendRuns, diagnose } from "../../../eval/backends.js";
import { loadEvalConfig } from "../../../eval/config.js";
import type { Lab } from "../../../lab/scenario.js";
import { crashLoop } from "../../../lab/scenarios/k8s/crash-loop.js";
import { staleSecret } from "../../../lab/scenarios/k8s/stale-secret.js";

describe("diagnose", () => {
  it("refuses a scenario with write tools on the claude-code backend, which cannot answer approval forms", async () => {
    const config = loadEvalConfig({ SCENARIO: staleSecret.name, EVAL_BACKEND: "claude-code" });
    await expect(diagnose(config, {} as Lab, staleSecret, [])).rejects.toThrow("EVAL_BACKEND=anthropic");
  });
});

describe("assertBackendRuns", () => {
  const claudeCode = loadEvalConfig({ EVAL_ALL: "1", EVAL_BACKEND: "claude-code" });

  it("names the scenarios with write tools before any lab starts", () => {
    expect(() => assertBackendRuns(claudeCode, [crashLoop, staleSecret])).toThrow(/^stale-secret offer write tools/);
  });

  it("lets read-only scenarios run on claude-code, and every scenario on an API backend", () => {
    expect(() => assertBackendRuns(claudeCode, [crashLoop])).not.toThrow();
    const anthropic = loadEvalConfig({ EVAL_ALL: "1", EVAL_BACKEND: "anthropic", ANTHROPIC_API_KEY: "test-key" });
    expect(() => assertBackendRuns(anthropic, [crashLoop, staleSecret])).not.toThrow();
  });
});
