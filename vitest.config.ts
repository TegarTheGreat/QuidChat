import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // Membangun Postgres WASM lalu menerapkan migrasi butuh sekitar 7 detik.
    testTimeout: 20_000,
    // `hookTimeout` TIDAK mewarisi `testTimeout` — defaultnya tetap 10 detik.
    // Test yang menyiapkan satu database bersama di `beforeAll` melampauinya
    // (bangun + seed), dan gagalnya muncul sebagai "Hook timed out in 10000ms"
    // yang tidak menyebut database sama sekali.
    hookTimeout: 60_000,
  },
})
