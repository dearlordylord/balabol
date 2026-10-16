import { defineConfig } from "vitest/config"
import config from "./vitest.config.ts"

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ["src/**/*.slow.test.ts", "test/**/*.slow.test.ts"],
    exclude: [],
    coverage: { enabled: false }
  }
})
