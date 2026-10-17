import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Temporary allowance for validation on the CPU-contended development host.
    testTimeout: 15_000,
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/*.slow.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
      reporter: ["text-summary", "json"]
    }
  }
})
