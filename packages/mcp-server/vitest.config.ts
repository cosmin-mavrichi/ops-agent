import { configDefaults, defineConfig } from "vitest/config";

// `pnpm build` compiles the tests into dist/; without this they would run twice, from stale copies.
// Hooks get 60s: stopping a container waits up to 10s for it to exit before killing it, which alone fills the
// default 10s hook timeout on a busy CI runner, failing a run whose tests all passed.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "dist/**"], hookTimeout: 60_000 },
});
