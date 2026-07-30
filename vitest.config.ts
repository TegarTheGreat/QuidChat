import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // Building Postgres WASM and applying the migrations takes about seven seconds.
    testTimeout: 20_000,
    // `hookTimeout` does NOT inherit from `testTimeout` — it stays at its 10 second
    // default. A `beforeAll` that builds a shared database exceeds that, and the
    // failure surfaces as "Hook timed out in 10000ms" without mentioning the
    // database at all, which makes it expensive to diagnose.
    hookTimeout: 60_000,
    // Test files run SEQUENTIALLY, not in parallel. Every database test file starts
    // its own Postgres WASM instance, and several running at once kill the worker
    // with "Worker exited unexpectedly" — a message that mentions neither memory nor
    // the database.
    //
    // Measured with three database files: parallel killed the worker and ran 34 of 38
    // tests; sequential ran all 38 AND finished faster (26.9s versus 29.0s), because
    // nothing was competing for memory.
    fileParallelism: false,
  },
})
