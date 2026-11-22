import { createPgClient } from "../src/adapters/pg.js";
import { createRedisClient } from "../src/adapters/redis.js";
import { allTools, toolsFor } from "../src/tools/index.js";
import { startHarness } from "../test/harness.js";
import { type K3sFixture, startK3s } from "../test/integration/k8s/k8s-fixture.js";
import { OPS_PW, type PgFixture, startPostgres } from "../test/integration/postgres/pg-fixture.js";
import { OPS_REDIS_PW, type RedisFixture, startRedis } from "../test/integration/redis/redis-fixture.js";

export type ToolResult = Awaited<ReturnType<Awaited<ReturnType<typeof startHarness>>["call"]>>;

/** One tool call and what its output must show for the incident to be diagnosable. */
export interface Evidence {
  readonly tool: string;
  /** Static args, or computed from the live lab (e.g. a pod name the agent would read from k8s_pods). */
  readonly args?: Readonly<Record<string, unknown>> | ((lab: Lab) => Promise<Record<string, unknown>>);
  /** What this proves, e.g. "the worker is crash-looping". */
  readonly shows: string;
  /** Throws when the evidence is missing. Retried, because live state flips (e.g. crash loops). */
  check(result: ToolResult): void;
}

export interface Scenario {
  readonly name: string;
  /** The diagnosis a good agent reaches; the evals (roadmap step 6) grade against it. */
  readonly rootCause: string;
  /** Values planted in the scenario that must never appear in any tool output. */
  readonly secrets: readonly string[];
  /** Breaks one thing and waits until the failure is observable. */
  break(lab: Lab): Promise<void>;
  readonly evidence: readonly Evidence[];
}

/** A fresh cluster and database per scenario, reached through the real MCP server with ops credentials. */
export interface Lab {
  readonly k3s: K3sFixture;
  readonly db: PgFixture;
  /** Valkey, the Redis-compatible server a new self-hosted setup most likely runs. */
  readonly cache: RedisFixture;
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Registers cleanup that must run before the containers stop (e.g. closing app sessions). */
  onStop(cleanup: () => Promise<unknown>): void;
  stop(): Promise<void>;
}

export async function startLab(): Promise<Lab> {
  const [k3s, db, cache] = await Promise.all([startK3s(), startPostgres(), startRedis("valkey")]);
  const pg = createPgClient({ connectionString: db.opsUrl, onError: () => {} });
  const harness = await startHarness({
    tools: toolsFor(allTools, ["pg", "k8s", "redis"]),
    pg,
    k8s: k3s.ops,
    redis: createRedisClient({ url: cache.opsUrl, onError: () => {} }),
    knownSecrets: [OPS_PW, k3s.token, OPS_REDIS_PW],
  });
  const cleanups: Array<() => Promise<unknown>> = [];

  return {
    k3s,
    db,
    cache,
    call: (tool, args = {}) => harness.call(tool, args),
    onStop: (cleanup) => cleanups.push(cleanup),
    async stop() {
      for (const cleanup of cleanups.toReversed()) await cleanup().catch(() => undefined);
      await harness.close();
      await pg.end();
      await Promise.all([k3s.stop(), db.stop(), cache.stop()]);
    },
  };
}

/** Polls until `check` stops throwing; on timeout rethrows its last error, labelled with `what`. */
export async function until(what: string, check: () => Promise<unknown>, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${err}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
