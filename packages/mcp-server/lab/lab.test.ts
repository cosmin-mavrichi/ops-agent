/**
 * Fault lab: each scenario gets a fresh k3s cluster and Postgres, breaks one thing, and checks that the
 * evidence for the diagnosis shows up in the tools' output. Run: pnpm lab, or SCENARIO=<name> pnpm lab.
 * Tool outputs (as the model would see them) are saved to lab/results/<scenario>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Lab, Scenario, ToolResult } from "./scenario.js";
import { startLab } from "./scenario.js";
import { crashLoop } from "./scenarios/k8s/crash-loop.js";
import { expiringCertificate } from "./scenarios/k8s/expiring-certificate.js";
import { lockContention } from "./scenarios/postgres/lock-contention.js";
import { cacheFull } from "./scenarios/redis/cache-full.js";
import { slowKeys } from "./scenarios/redis/slow-keys.js";
import { appSecretInLogs } from "./scenarios/security/app-secret-in-logs.js";
import { promptInjection } from "./scenarios/security/prompt-injection.js";

const scenarios: readonly Scenario[] = [
  crashLoop,
  expiringCertificate,
  lockContention,
  cacheFull,
  slowKeys,
  promptInjection,
  appSecretInLogs,
];

const only = process.env.SCENARIO;
const selected = only ? scenarios.filter((s) => s.name === only) : scenarios;
if (selected.length === 0) {
  throw new Error(`unknown SCENARIO "${only}"; available: ${scenarios.map((s) => s.name).join(", ")}`);
}

const RESULTS_DIR = new URL("./results/", import.meta.url);

interface Recorded {
  tool: string;
  args: Record<string, unknown>;
  shows: string;
  found: boolean;
  output: unknown;
}

describe.each(selected)("$name", (scenario) => {
  let lab: Lab;
  const recorded: Recorded[] = [];
  const everyOutput: string[] = [];

  beforeAll(async () => {
    lab = await startLab(scenario.mountedSecrets);
    await scenario.break(lab);
  }, 360_000);

  afterAll(async () => {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(
      new URL(`${scenario.name}.json`, RESULTS_DIR),
      `${JSON.stringify({ scenario: scenario.name, root_cause: scenario.rootCause, evidence: recorded }, null, 2)}\n`,
    );
    await lab?.stop();
  }, 120_000);

  for (const evidence of scenario.evidence) {
    it(`${evidence.tool} shows ${evidence.shows}`, async () => {
      const args = typeof evidence.args === "function" ? await evidence.args(lab) : { ...evidence.args };
      let last: ToolResult | undefined;
      try {
        await vi.waitFor(
          async () => {
            last = await lab.call(evidence.tool, args);
            everyOutput.push(last.text);
            expect(last.isError).toBe(false);
            evidence.check(last);
          },
          { timeout: 60_000, interval: 2_000 },
        );
        recorded.push({ tool: evidence.tool, args, shows: evidence.shows, found: true, output: last?.json });
      } catch (err) {
        recorded.push({
          tool: evidence.tool,
          args,
          shows: evidence.shows,
          found: false,
          output: last?.json ?? last?.text,
        });
        throw err;
      }
    }, 90_000);
  }

  it("never leaks a planted secret", () => {
    expect(everyOutput.length).toBeGreaterThan(0);
    for (const secret of scenario.secrets) {
      for (const output of everyOutput) expect(output).not.toContain(secret);
    }
  });
});
