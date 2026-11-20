import { readFileSync } from "node:fs";
import { createClient } from "@redis/client";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

export const ADMIN_PW = "redis-admin-pw-5527";
export const OPS_REDIS_PW = "redis-ops-pw-6638";

/** Valkey is the default (what a new self-hosted setup most likely runs); Redis is tested too. */
export const IMAGES = {
  valkey: { image: "valkey/valkey:9.1.3-alpine", server: "valkey-server" },
  redis: { image: "redis:8.10.3-alpine", server: "redis-server" },
} as const;
export type Flavor = keyof typeof IMAGES;

// The same rules production applies (deploy/redis/ops-ro.acl), minus comments.
const OPS_ACL_RULES = readFileSync(new URL("../../../../../deploy/redis/ops-ro.acl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.startsWith("#"))
  .flatMap((line) => line.trim().split(/\s+/));

const newClient = (url: string, name?: string) => createClient({ url, name, RESP: 2, disableClientInfo: true });
export type Connection = ReturnType<typeof newClient>;

export interface RedisFixture {
  readonly flavor: Flavor;
  readonly container: StartedTestContainer;
  /** The default (admin) user, for seeding and changing config. */
  readonly admin: Connection;
  /** URL for the ops_ro ACL user, set up exactly as deploy/redis/ops-ro.acl says. */
  readonly opsUrl: string;
  /** A new admin-level connection under a client name, to simulate an application. */
  connectApp(name: string): Promise<Connection>;
  /** Connects as ops_ro directly, bypassing the adapter, to test what the ACL alone allows. */
  connectOps(): Promise<Connection>;
  stop(): Promise<void>;
}

export async function startRedis(flavor: Flavor = "valkey"): Promise<RedisFixture> {
  const { image, server } = IMAGES[flavor];
  const container = await new GenericContainer(image)
    .withCommand([server, "--requirepass", ADMIN_PW])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();

  const address = `${container.getHost()}:${container.getMappedPort(6379)}`;
  const opened: Connection[] = [];
  const connect = async (url: string, name?: string) => {
    const client = newClient(url, name);
    client.on("error", () => {}); // tests close connections on purpose
    await client.connect();
    opened.push(client);
    return client;
  };

  const admin = await connect(`redis://default:${ADMIN_PW}@${address}`, "admin");
  await admin.sendCommand(["ACL", "SETUSER", "ops_ro", "reset", "on", `>${OPS_REDIS_PW}`, ...OPS_ACL_RULES]);
  const opsUrl = `redis://ops_ro:${OPS_REDIS_PW}@${address}`;

  return {
    flavor,
    container,
    admin,
    opsUrl,
    connectApp: (name) => connect(`redis://default:${ADMIN_PW}@${address}`, name),
    connectOps: () => connect(opsUrl),
    async stop() {
      await Promise.all(opened.map((client) => client.close().catch(() => undefined)));
      await container.stop();
    },
  };
}
