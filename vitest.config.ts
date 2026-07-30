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
    // Berkas test dijalankan BERURUTAN, tidak paralel. Setiap berkas test database
    // menyalakan Postgres WASM sendiri, dan beberapa berkas yang jalan bersamaan
    // membuat worker mati dengan "Worker exited unexpectedly" — pesan yang tidak
    // menyebut memori maupun database, jadi sangat mahal untuk didiagnosis.
    // Terukur: dengan tiga berkas database, paralel = worker mati (34 dari 38 test
    // jalan); berurutan = 38 dari 38 DAN durasinya justru lebih singkat (26,9s vs
    // 29,0s), karena tidak ada lagi memori yang saling berebut.
    fileParallelism: false,
  },
})
