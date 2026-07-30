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
  // Served by @quidchat/server under /panel, so asset URLs have to be built with that
  // prefix. Left at the default "/", index.html would ask for /assets/index-*.js and get
  // the API's 404 — the panel would load as a blank page with no clue why.
  base: "/panel/",
  build: {
    outDir: "dist",
  },
})
