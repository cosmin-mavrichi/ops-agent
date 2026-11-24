import { defineConfig } from "vitest/config";

export default defineConfig({
  // Read @ops-agent/mcp-server/shared from source, like typecheck: tests run before any build.
  resolve: { conditions: ["@ops-agent/source"] },
  ssr: { resolve: { conditions: ["@ops-agent/source"] } },
});
