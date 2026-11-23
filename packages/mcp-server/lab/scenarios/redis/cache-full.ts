import { expect } from "vitest";
import type { Scenario } from "../../scenario.js";

const SESSION_TOKEN = "3c9e1f07b2a84d55labsession";
const CARD_TOKEN = "tok_lab_cache_card_2290";
const BLOB = "x".repeat(400_000);

export const cacheFull: Scenario = {
  name: "cache-full",
  rootCause:
    "The cache (Valkey) is at its 2 MB maxmemory with policy noeviction, so it refuses every write with OOM " +
    "errors instead of evicting old keys. The checkout service's session writes fail.",
  symptom: "Checkout fails for everyone: users get logged out or can't keep a session.",
  fix: "Raise maxmemory or switch to an evicting policy such as allkeys-lru.",
  lookAt: "redis_health (memory, policy, OOM rejections).",
  secrets: [SESSION_TOKEN, CARD_TOKEN],

  async break(lab) {
    await lab.cache.admin.configSet({ maxmemory: "2mb", "maxmemory-policy": "noeviction" });
    const checkout = await lab.cache.connectApp("checkout");
    await checkout.set(`session:${SESSION_TOKEN}`, JSON.stringify({ card_token: CARD_TOKEN }));

    let refused = 0;
    const countRefusal = (err: unknown) => {
      if (!String(err).includes("OOM")) throw err;
      refused++;
    };
    for (let i = 0; i < 200 && refused < 5; i++) {
      // Sequential on purpose: each write fills memory, and the loop stops after the 5th OOM refusal.
      await checkout.set(`cart:${i}`, BLOB).catch(countRefusal); // NOSONAR
    }
    expect(refused).toBe(5);
  },

  evidence: [
    {
      tool: "redis_health",
      shows: "memory is at maxmemory with noeviction, and writes are being refused with OOM",
      check: ({ json }) => {
        expect(json.memory).toMatchObject({ max_mb: 2, policy: "noeviction" });
        expect(json.memory.used_pct).toBeGreaterThanOrEqual(90);
        expect(json.errors.by_type.OOM).toBeGreaterThanOrEqual(5);
        expect(json.warnings.join("\n")).toContain("writes fail with OOM");
        expect(json.clients.top.map((c: { name: string }) => c.name)).toContain("checkout");
      },
    },
  ],
};
