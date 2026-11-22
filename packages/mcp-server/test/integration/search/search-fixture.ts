import { readFileSync } from "node:fs";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

// OpenSearch refuses an initial admin password that resembles "admin".
export const ADMIN_PW = "Zq7-Lantern-Orbit-2291!";
export const OPS_SEARCH_PW = "search-ops-pw-4290";

// Pinned like npm packages: a release at least 7 days old (see pnpm-workspace.yaml minimumReleaseAge).
const ENGINES = {
  opensearch: { image: "opensearchproject/opensearch:3.9.0", admin: "admin", dataPath: "/usr/share/opensearch/data" },
  elasticsearch: {
    image: "docker.elastic.co/elasticsearch/elasticsearch:9.5.6",
    admin: "elastic",
    dataPath: "/usr/share/elasticsearch/data",
  },
} as const;
export type Engine = keyof typeof ENGINES;

const roleFile = (engine: Engine) => {
  const path = new URL(`../../../../../deploy/search/${engine}-ops-ro.json`, import.meta.url);
  const { _comment, ...role } = JSON.parse(readFileSync(path, "utf8"));
  return role as object;
};

export interface SearchFixture {
  readonly engine: Engine;
  readonly container: StartedTestContainer;
  /** URL as the ops_ro user, with the role from deploy/search/<engine>-ops-ro.json. */
  readonly opsUrl: string;
  /** Sends a request as the admin user, for seeding; throws on an error status. */
  admin(method: string, path: string, body?: unknown): Promise<unknown>;
  /** Sends a request as ops_ro directly, bypassing the adapter, to test what the role alone allows. */
  asOps(method: string, path: string, body?: unknown): Promise<Response>;
  stop(): Promise<void>;
}

const ENVIRONMENT: Record<Engine, Record<string, string>> = {
  opensearch: {
    "discovery.type": "single-node",
    OPENSEARCH_INITIAL_ADMIN_PASSWORD: ADMIN_PW,
    OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m",
    // The security plugin still authenticates and authorizes every request; only TLS is off, for the test.
    "plugins.security.ssl.http.enabled": "false",
  },
  elasticsearch: {
    "discovery.type": "single-node",
    ELASTIC_PASSWORD: ADMIN_PW,
    ES_JAVA_OPTS: "-Xms512m -Xmx512m",
    "xpack.security.enabled": "true",
    "xpack.security.http.ssl.enabled": "false",
    "xpack.security.transport.ssl.enabled": "false",
  },
};

/**
 * A single-node engine with security on and its data on a tmpfs of `dataMb`: disk watermarks are measured
 * on the data filesystem, and the host's disk would otherwise decide whether the cluster turns read-only.
 */
export async function startSearch(engine: Engine, dataMb = 1024): Promise<SearchFixture> {
  const { image, admin: adminUser, dataPath } = ENGINES[engine];
  const container = await new GenericContainer(image)
    .withEnvironment(ENVIRONMENT[engine])
    .withTmpFs({ [dataPath]: `rw,size=${dataMb}m,uid=1000,gid=1000` })
    .withExposedPorts(9200)
    .withWaitStrategy(
      Wait.forHttp("/_cluster/health", 9200)
        .withBasicCredentials(adminUser, ADMIN_PW)
        .forStatusCode(200)
        .withStartupTimeout(180_000),
    )
    .start();

  const base = `http://${container.getHost()}:${container.getMappedPort(9200)}`;
  const send = (user: string, password: string) => (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const asAdmin = send(adminUser, ADMIN_PW);
  const admin = async (method: string, path: string, body?: unknown) => {
    const response = await asAdmin(method, path, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
    return text ? JSON.parse(text) : undefined;
  };

  await createOpsUser(engine, admin);
  return {
    engine,
    container,
    opsUrl: `http://ops_ro:${OPS_SEARCH_PW}@${container.getHost()}:${container.getMappedPort(9200)}`,
    admin,
    asOps: send("ops_ro", OPS_SEARCH_PW),
    stop: async () => {
      await container.stop();
    },
  };
}

type Admin = (method: string, path: string, body?: unknown) => Promise<unknown>;

async function createOpsUser(engine: Engine, admin: Admin): Promise<void> {
  if (engine === "opensearch") {
    await admin("PUT", "/_plugins/_security/api/roles/ops_ro", roleFile(engine));
    await admin("PUT", "/_plugins/_security/api/internalusers/ops_ro", { password: OPS_SEARCH_PW });
    await admin("PUT", "/_plugins/_security/api/rolesmapping/ops_ro", { users: ["ops_ro"] });
    return;
  }
  await admin("POST", "/_security/role/ops_ro", roleFile(engine));
  await admin("POST", "/_security/user/ops_ro", { password: OPS_SEARCH_PW, roles: ["ops_ro"] });
}
