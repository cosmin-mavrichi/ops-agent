import { defineConfig } from "vitest/config";

export default defineConfig({
  // Read @ops-agent/mcp-server/shared from source, like typecheck: tests run before any build.
  resolve: { conditions: ["@ops-agent/source"] },
  ssr: { resolve: { conditions: ["@ops-agent/source"] } },
  // Hooks get 60s, as in the read server: stopping the k3s container alone can fill the default 10s on CI.
  test: { hookTimeout: 60_000 },
});
