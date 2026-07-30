import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Plain Vite app: talks to the QuidChat admin API over HTTP, no server-side code
// of its own. Every dependency here only affects the browser bundle, never the
// runtime the businesses deploy.
//
// Imports use relative paths rather than an "@/" alias: the repo's root
// `vitest.config.ts` runs every package's tests through one shared config
// with no alias resolution, and this package cannot add one without touching
// files outside `packages/admin`.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
})
