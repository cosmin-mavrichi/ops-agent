import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/client";
import { createPgClient } from "../src/adapters/pg.js";
import { createPromClient } from "../src/adapters/prometheus.js";
import { createRedisClient } from "../src/adapters/redis.js";
import { createSearchClient } from "../src/adapters/search.js";
import { readSecretsDir } from "../src/lib/known-secrets.js";
import { allTools, toolsFor } from "../src/tools/index.js";
import type { Adapter } from "../src/types.js";
import { startHarness } from "../test/harness.js";
import { type K3sFixture, startK3s } from "../test/integration/k8s/k8s-fixture.js";
import { OPS_PW, type PgFixture, startPostgres } from "../test/integration/postgres/pg-fixture.js";
import { OPS_REDIS_PW, type RedisFixture, startRedis } from "../test/integration/redis/redis-fixture.js";
import {
  type Engine,
  OPS_SEARCH_PW,
  type SearchFixture,
  type SearchOptions,
  startSearch,
} from "../test/integration/search/search-fixture.js";
import { startMonitoring } from "./monitoring.js";

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
  /** What an on-call person would report; the only thing the eval's agent is told (eval/cases.md). */
  readonly symptom: string;
  /** What a correct report proposes, or "nothing to fix". */
  readonly fix: string;
  /** The resources and tool outputs that show the cause. */
  readonly lookAt: string;
  /** Values planted in the scenario that must never appear in any tool output. */
  readonly secrets: readonly string[];
  /**
   * App secrets the operator mounts into the ops pod for redaction (OPS_KNOWN_SECRETS_DIR), as key → value.
   * Separate from `secrets`: a scenario can plant secrets nobody told the agent about.
   */
  readonly mountedSecrets?: Readonly<Record<string, string>>;
  /** A search engine, started only for the scenarios that need one (it takes a GiB of memory). */
  readonly search?: { readonly engine: Engine } & SearchOptions;
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
  /** Only when the scenario asked for one. */
  readonly search: SearchFixture | undefined;
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** The tools the server exposes, as the MCP client lists them (name, description, input schema). */
  listTools(): Promise<Tool[]>;
  /** Environment for running the real server (dist/src/index.js) against this lab, as production configures it. */
  readonly serverEnv: Readonly<Record<string, string>>;
  /** Registers cleanup that must run before the containers stop (e.g. closing app sessions). */
  onStop(cleanup: () => Promise<unknown>): void;
  stop(): Promise<void>;
}

type LabNeeds = Pick<Scenario, "mountedSecrets" | "search">;

export async function startLab(needs: LabNeeds = {}): Promise<Lab> {
  const searchStarting = needs.search ? startSearch(needs.search.engine, needs.search) : undefined;
  const [k3s, db, cache, search] = await Promise.all([
    startK3s(),
    startPostgres(),
    startRedis("valkey"),
    searchStarting,
  ]);
  // The fixture's own setup (CREATE ROLE ... PASSWORD) is not part of any incident; left in, the agent reports it.
  await db.admin.query("SELECT pg_stat_statements_reset()");
  const pg = createPgClient({ connectionString: db.opsUrl, onError: () => {} });
  const [appSecrets, monitoring] = await Promise.all([
    readMountedSecrets(k3s, needs.mountedSecrets ?? {}),
    startMonitoring(k3s),
  ]);
  const searchAdapters: Adapter[] = search ? ["search"] : [];
  const searchClient = search ? createSearchClient({ url: search.opsUrl }) : undefined;
  const harness = await startHarness({
    tools: toolsFor(allTools, ["pg", "k8s", "redis", "prom", ...searchAdapters]),
    pg,
    k8s: k3s.ops,
    redis: createRedisClient({ url: cache.opsUrl, onError: () => {} }),
    prom: createPromClient({ url: monitoring.prometheus.url }),
    search: searchClient,
    knownSecrets: [OPS_PW, k3s.token, OPS_REDIS_PW, OPS_SEARCH_PW, monitoring.token, ...appSecrets],
  });
  const cleanups: Array<() => Promise<unknown>> = [];
  const serverConfig = writeServerConfig({ k3s, db, cache, search, promUrl: monitoring.prometheus.url });
  const knownSecrets = [k3s.token, monitoring.token, ...appSecrets];

  return {
    k3s,
    db,
    cache,
    search,
    call: (tool, args = {}) => harness.call(tool, args),
    listTools: async () => (await harness.client.listTools()).tools,
    serverEnv: { ...serverConfig.env, OPS_KNOWN_SECRETS: knownSecrets.join(",") },
    onStop: (cleanup) => cleanups.push(cleanup),
    async stop() {
      for (const cleanup of cleanups.toReversed()) await cleanup().catch(() => undefined);
      await harness.close();
      await pg.end();
      rmSync(serverConfig.dir, { recursive: true, force: true });
      await Promise.all([monitoring.prometheus.stop(), k3s.stop(), db.stop(), cache.stop(), search?.stop()]);
    },
  };
}

interface ServerTargets {
  readonly k3s: K3sFixture;
  readonly db: PgFixture;
  readonly cache: RedisFixture;
  readonly search: SearchFixture | undefined;
  readonly promUrl: string;
}

/** The server reads the Kubernetes token and CA from files, as in a pod; they go to a temp dir. */
function writeServerConfig(targets: ServerTargets): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "ops-lab-server-"));
  const tokenFile = join(dir, "token");
  const caFile = join(dir, "ca.crt");
  writeFileSync(tokenFile, targets.k3s.token);
  writeFileSync(caFile, targets.k3s.ca);
  const env: Record<string, string> = {
    OPS_PG_URL: targets.db.opsUrl,
    OPS_K8S_NAMESPACES: targets.k3s.ops.namespaces.join(","),
    OPS_K8S_SERVER: targets.k3s.server,
    OPS_K8S_TOKEN_FILE: tokenFile,
    OPS_K8S_CA_FILE: caFile,
    OPS_REDIS_URL: targets.cache.opsUrl,
    OPS_PROM_URL: targets.promUrl,
  };
  if (targets.search) env.OPS_SEARCH_URL = targets.search.opsUrl;
  return { dir, env };
}

// Each name appears in several manifest fields that must agree; a mismatch only shows as a 150s wait timeout.
const OPS_NAMESPACE = "ops";
const SECRET_NAME = "ops-known-secrets";
const AGENT_POD = "ops-agent";
const VOLUME_NAME = "known-secrets";
const MOUNT_PATH = "/var/run/secrets/ops-known";

/**
 * Production path, for real: the values go into a Secret in `ops`, are mounted into a pod running as the
 * ops ServiceAccount, and the mounted directory (symlinks and all) is read with readSecretsDir.
 */
async function readMountedSecrets(k3s: K3sFixture, secrets: Readonly<Record<string, string>>): Promise<string[]> {
  if (Object.keys(secrets).length === 0) return [];

  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: SECRET_NAME, namespace: OPS_NAMESPACE },
    stringData: secrets,
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: AGENT_POD, namespace: OPS_NAMESPACE },
    spec: {
      serviceAccountName: "ops-ro",
      containers: [
        {
          name: "agent",
          image: "busybox:1.37",
          command: ["sleep", "3600"],
          volumeMounts: [{ name: VOLUME_NAME, mountPath: MOUNT_PATH, readOnly: true }],
        },
      ],
      volumes: [{ name: VOLUME_NAME, secret: { secretName: SECRET_NAME } }],
    },
  };
  // JSON is valid YAML, and it quotes the values safely.
  await k3s.apply([secret, pod].map((manifest) => JSON.stringify(manifest)).join("\n---\n"));
  await k3s.kubectl("wait", "--for=condition=Ready", `pod/${AGENT_POD}`, "-n", OPS_NAMESPACE, "--timeout=150s");

  const dir = await k3s.copyFromPod(OPS_NAMESPACE, AGENT_POD, MOUNT_PATH);
  try {
    return readSecretsDir(dir, (message) => {
      throw new Error(`scenario secret unusable: ${message}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
