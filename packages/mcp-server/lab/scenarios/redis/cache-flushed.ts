import { expect } from "vitest";
import type { Scenario } from "../../scenario.js";

const SESSION_TOKEN = "e48a2b19c07d4f63labflushed";
const CARD_TOKEN = "tok_lab_flushed_card_6145";
const SESSIONS = 200;
const SIGNED_IN_AGAIN = 3;

export const cacheFlushed: Scenario = {
  name: "cache-flushed",
  rootCause:
    "Someone ran FLUSHALL on the cache (Valkey) that holds the checkout service's sessions, deleting every key: " +
    "all users were logged out at once. Nothing else changed; the cache is healthy and refilling as users sign in.",
  symptom: "Everyone was logged out at once a few minutes ago and had to sign in again. Nothing was deployed.",
  fix:
    "Find the script or person that ran FLUSHALL against this instance (it cannot be undone; users sign in " +
    "again) and stop it happening again: deny FLUSHALL and FLUSHDB in the ACL of every user but an admin.",
  lookAt: "redis_changes (FLUSHALL ran since the server started; few keys left).",
  secrets: [SESSION_TOKEN, CARD_TOKEN],

  async break(lab) {
    const checkout = await lab.cache.connectApp("checkout");
    await checkout.set(`session:${SESSION_TOKEN}`, JSON.stringify({ card_token: CARD_TOKEN }));
    for (let i = 0; i < SESSIONS; i++) await checkout.set(`session:lab-user-${i}`, "{}"); // NOSONAR

    // The incident: a cleanup script pointed at the production cache.
    await lab.cache.admin.flushAll();
    for (let i = 0; i < SIGNED_IN_AGAIN; i++) await checkout.set(`session:lab-again-${i}`, "{}"); // NOSONAR
  },

  evidence: [
    {
      tool: "redis_changes",
      shows: "FLUSHALL ran once since the server started, and only the few sessions created since are left",
      check: ({ json }) => {
        expect(json.admin_commands).toContainEqual(expect.objectContaining({ command: "FLUSHALL", runs: 1 }));
        expect(json.keys).toBe(SIGNED_IN_AGAIN);
      },
    },
    {
      tool: "redis_health",
      shows: "the cache itself is healthy: nothing evicted or refused, and checkout is connected",
      check: ({ json }) => {
        expect(json.errors.by_type).toEqual({});
        expect(json.memory.evicted_keys).toBe(0);
        expect(json.clients.top.map((c: { name: string }) => c.name)).toContain("checkout");
      },
    },
  ],
};
