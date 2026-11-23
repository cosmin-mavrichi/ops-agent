import { expect } from "vitest";
import type { Scenario } from "../../scenario.js";

// Big enough that each call takes a visible 50 ms or more, as the symptom says: with a tenth of this, the
// calls took about 5 ms and the agent rightly doubted they could stall a site.
const ORDERS = 1_000_000;
const REPORT_FIELDS = 500_000;
const SEED_BATCH = 100_000;

const batchStarts = (total: number) => Array.from({ length: Math.ceil(total / SEED_BATCH) }, (_, i) => i * SEED_BATCH);
const indexesFrom = (start: number, total: number) =>
  Array.from({ length: Math.min(SEED_BATCH, total - start) }, (_, i) => start + i);
const REPORT_TOKEN = "rpt9x2k7q4m1z8w3v6blab";

export const slowKeys: Scenario = {
  name: "slow-keys",
  rootCause:
    `A reporting job runs KEYS over ${ORDERS.toLocaleString("en")} order keys and reads a ` +
    `${REPORT_FIELDS.toLocaleString("en")}-field hash in one HGETALL. The cache runs commands one at a time, so ` +
    "each call stalls every other client; the job should use SCAN and HSCAN.",
  symptom: "The whole site stalls for a moment, several times an hour, every endpoint at once.",
  fix: "Change the reporting job to use SCAN and HSCAN instead of KEYS and HGETALL.",
  lookAt: "redis_slowlog.",
  secrets: [REPORT_TOKEN],

  async break(lab) {
    // A common production threshold, lower than the 10 ms default so the lab stays fast.
    await lab.cache.admin.configSet({ "slowlog-log-slower-than": "2000" });

    const seed = await lab.cache.connectApp("seed");
    for (const start of batchStarts(ORDERS)) {
      const orders = seed.multi();
      for (const i of indexesFrom(start, ORDERS)) orders.set(`order:${i}`, "1");
      await orders.exec();
    }
    for (const start of batchStarts(REPORT_FIELDS)) {
      const fields = Object.fromEntries(indexesFrom(start, REPORT_FIELDS).map((i) => [`line${i}`, "1"]));
      await seed.hSet(`report:${REPORT_TOKEN}`, fields);
    }
    // The seeding is setup, not part of the incident.
    await lab.cache.admin.sendCommand(["SLOWLOG", "RESET"]);

    const reports = await lab.cache.connectApp("reports");
    // As a repeating job would: each run lists the orders and reads the report, so both show up alike.
    for (let i = 0; i < 3; i++) {
      await reports.keys("order:*");
      await reports.hGetAll(`report:${REPORT_TOKEN}`);
    }
  },

  evidence: [
    {
      tool: "redis_slowlog",
      shows: "KEYS and HGETALL from the reports client are the slow commands, with key names masked",
      check: ({ json }) => {
        expect(json.by_command).toContainEqual(expect.objectContaining({ command: "KEYS", count: 3 }));
        expect(json.by_command).toContainEqual(expect.objectContaining({ command: "HGETALL", count: 3 }));
        const shapes = json.entries.map(
          (e: { command: string; key_shape: string; client_name: string }) =>
            `${e.client_name} ${e.command} ${e.key_shape}`,
        );
        expect(shapes).toContain("reports KEYS order:?");
        expect(shapes).toContain("reports HGETALL report:?");
        const problems = json.problems.join("\n");
        expect(problems).toContain("KEYS from reports");
        expect(problems).toContain("Use HSCAN instead");
      },
    },
  ],
};
