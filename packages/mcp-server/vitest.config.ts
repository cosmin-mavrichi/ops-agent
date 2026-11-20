import { configDefaults, defineConfig } from "vitest/config";

// `pnpm build` compiles the tests into dist/; without this they would run twice, from stale copies.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "dist/**"] },
});
