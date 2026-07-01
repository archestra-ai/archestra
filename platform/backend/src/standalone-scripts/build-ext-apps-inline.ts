/**
 * Build the self-contained ext-apps guest bundle for the inline (foreign-host)
 * MCP-App serve path. A strict MCP-Apps host (claude.ai) applies its own sandbox
 * CSP that refuses cross-origin `<script src>`, so the connector inlines this
 * bundle into the resource HTML rather than linking it from the platform origin.
 *
 * esbuild converts the ESM `@modelcontextprotocol/ext-apps` bundle to a classic
 * IIFE that publishes `{ App, PostMessageTransport, ... }` on
 * `window.__ARCHESTRA_EXT_APPS__`; the injected Apps SDK reads that global.
 */
import path from "node:path";
import { buildSync } from "esbuild";

/**
 * Generate the bundle into the static dir (so tsdown copies it to `dist/static`).
 * Called from the tsdown build/watch (covers `build` and `dev`) and from vitest
 * `global-setup` (so `pnpm test` is self-sufficient), both with the backend as
 * cwd. Gitignored and regenerated, so it tracks the installed ext-apps version.
 * Keep the filename in sync with `EXT_APPS_INLINE_GLOBAL_FILENAME` in
 * `services/apps/app-sdk-injection.ts` (the runtime reads it).
 */
export function buildExtAppsInlineBundle(): void {
  const backendRoot = process.cwd();
  buildSync({
    stdin: {
      contents: [
        'import * as ExtApps from "@modelcontextprotocol/ext-apps/app-with-deps";',
        "globalThis.__ARCHESTRA_EXT_APPS__ = ExtApps;",
      ].join("\n"),
      resolveDir: backendRoot,
      loader: "js",
    },
    bundle: true,
    format: "iife",
    minify: true,
    platform: "browser",
    // Preserve bundled third-party license notices — the bundle ships to end users.
    legalComments: "eof",
    outfile: path.join(backendRoot, "src/static/ext-apps-app.global.js"),
  });
}
