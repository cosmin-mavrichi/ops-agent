import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { GenericContainer, TestContainers, Wait } from "testcontainers";

// Pinned like npm packages: a release at least 7 days old (see pnpm-workspace.yaml minimumReleaseAge).
const IMAGE = "prom/prometheus:v3.16.0";

export interface PromFixture {
  /** Base URL of the query API. */
  readonly url: string;
  stop(): Promise<void>;
}

/** Prometheus scraping every second with the given `scrape_configs` entries (YAML list items). */
export async function startPrometheus(scrapeConfigs: string): Promise<PromFixture> {
  const config = `global: { scrape_interval: 1s }\nscrape_configs:\n${scrapeConfigs}\n`;
  const container = await new GenericContainer(IMAGE)
    .withCopyContentToContainer([{ content: config, target: "/etc/prometheus/prometheus.yml" }])
    .withExposedPorts(9090)
    .withWaitStrategy(Wait.forLogMessage("Server is ready to receive web requests"))
    .start();

  return {
    url: `http://${container.getHost()}:${container.getMappedPort(9090)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

export interface MetricsTarget {
  /** host:port as Prometheus in a container reaches it. */
  readonly address: string;
  close(): void;
}

/** Serves `metrics()` (called per scrape, so values can change over time) to containers. */
export async function serveMetrics(metrics: () => string): Promise<MetricsTarget> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(metrics());
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  await TestContainers.exposeHostPorts(port);
  return { address: `host.testcontainers.internal:${port}`, close: () => server.close() };
}
