import type pg from "pg";
import { expect } from "vitest";
import { type Scenario, until } from "../../scenario.js";

const CARD_TOKEN = "tok_lab_card_5531";
const WAITERS = 3;

export const lockContention: Scenario = {
  name: "lock-contention",
  rootCause:
    "A session updated a row in orders and left its transaction open ('idle in transaction'). It holds the row " +
    `lock, so ${WAITERS} other sessions updating the same row are stuck waiting behind it.`,
  symptom: "Saving an order hangs and then times out. Reading orders still works.",
  fix: "End the blocking session; fix the app so it does not leave transactions open.",
  lookAt: "The root blocker in pg_blocking (and pg_activity).",
  secrets: [CARD_TOKEN],

  async break(lab) {
    await lab.db.admin.query("CREATE TABLE orders (id int PRIMARY KEY, status text, card_token text)");
    await lab.db.admin.query("INSERT INTO orders VALUES (1, 'new', NULL)");

    const holder = await lab.db.connectApp();
    await holder.query("BEGIN");
    await holder.query(`UPDATE orders SET status = 'paid', card_token = '${CARD_TOKEN}' WHERE id = 1`);

    const waiters: pg.Client[] = await Promise.all(Array.from({ length: WAITERS }, () => lab.db.connectApp()));
    const pending = waiters.map((w) =>
      w.query("UPDATE orders SET status = 'shipped' WHERE id = 1").catch(() => undefined),
    );
    lab.onStop(async () => {
      await lab.db.terminateApp();
      await Promise.all(pending);
      await Promise.all([holder, ...waiters].map((c) => c.end().catch(() => undefined)));
    });

    await until(`${WAITERS} sessions waiting on a lock`, async () => {
      const { rows } = await lab.db.admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
      );
      expect(rows[0].n).toBe(WAITERS);
    });
  },

  evidence: [
    {
      tool: "pg_blocking",
      shows: "one idle-in-transaction session is the root blocker of every waiting session",
      check: ({ json }) => {
        expect(json.waiting_sessions).toBe(WAITERS);
        expect(json.root_blockers).toHaveLength(1);
        expect(json.root_blockers[0]).toMatchObject({ state: "idle in transaction", blocks_total: WAITERS });
        expect(json.root_blockers[0].query).toContain("UPDATE orders SET status = ?");
      },
    },
    {
      tool: "pg_activity",
      shows: "the open transaction is the oldest session and the rest are waiting on locks",
      check: ({ json }) => {
        expect(json.connections).toMatchObject({ idle_in_transaction: 1, waiting_on_lock: WAITERS });
        expect(json.sessions[0]).toMatchObject({ state: "idle in transaction" });
      },
    },
  ],
};
