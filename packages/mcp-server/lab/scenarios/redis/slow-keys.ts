import { expect } from "vitest";
import type { Scenario } from "../../scenario.js";

const ORDERS = 100_000;
const REPORT_FIELDS = 50_000;
const REPORT_TOKEN = "rpt9x2k7q4m1z8w3v6blab";

export const slowKeys: Scenario = {
  name: "slow-keys",
  rootCause:
    `A reporting job runs KEYS over ${ORDERS.toLocaleString("en")} order keys and reads a ` +
    `${REPORT_FIELDS.toLocaleString("en")}-field hash in one HGETALL. The cache runs commands one at a time, so ` +
    "each call stalls every other client; the job should use SCAN and HSCAN.",
  secrets: [REPORT_TOKEN],

  async break(lab) {
    // A common production threshold, lower than the 10 ms default so the lab stays fast.
    await lab.cache.admin.configSet({ "slowlog-log-slower-than": "2000" });

    const seed = await lab.cache.connectApp("seed");
    const orders = seed.multi();
    for (let i = 0; i < ORDERS; i++) orders.set(`order:${i}`, "1");
    await orders.exec();
    const fields = Object.fromEntries(Array.from({ length: REPORT_FIELDS }, (_, i) => [`line${i}`, "1"]));
    await seed.hSet(`report:${REPORT_TOKEN}`, fields);

    const reports = await lab.cache.connectApp("reports");
    for (let i = 0; i < 3; i++) await reports.keys("order:*");
    await reports.hGetAll(`report:${REPORT_TOKEN}`);
  },

  evidence: [
    {
      tool: "redis_slowlog",
      shows: "KEYS and HGETALL from the reports client are the slow commands, with key names masked",
      check: ({ json }) => {
        expect(json.by_command[0]).toMatchObject({ command: "KEYS", count: 3 });
        const shapes = json.entries.map(
          (e: { command: string; key_shape: string; client_name: string }) =>
            `${e.client_name} ${e.command} ${e.key_shape}`,
        );
        expect(shapes).toContain("reports KEYS order:?");
        expect(shapes).toContain("reports HGETALL report:?");
      },
    },
  ],
};
