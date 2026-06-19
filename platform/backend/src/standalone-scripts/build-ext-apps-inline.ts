/**
 * Build the self-contained ext-apps guest bundle for the inline (foreign-host)
 * MCP-App serve path. A strict MCP-Apps host (claude.ai) applies its own sandbox
 * CSP that refuses cross-origin `<script src>`, so the connector inlines this
 * bundle into the resource HTML rather than linking it from the platform origin.
 *
 * esbuild converts the ESM `@modelcontextprotocol/ext-apps` bundle to a classic
 * IIFE that publishes `{ App, PostMessageTransport, ... }` on
 * `window.__ARCHESTRA_EXT_APPS__`; the injected Apps SDK reads that global when
 * present. Regenerated on every build/dev so it tracks the installed ext-apps
 * version, and gitignored (never committed).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "../..");
// Keep in sync with EXT_APPS_INLINE_GLOBAL_FILENAME in services/apps/app-sdk-injection.ts
// (the runtime reads this file from the static dir). A standalone build step, so
// it stays free of the app's config/native imports.
const outfile = path.resolve(scriptDir, "../static/ext-apps-app.global.js");

await esbuild.build({
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
  legalComments: "none",
  outfile,
});

process.stdout.write(`[build-ext-apps-inline] wrote ${outfile}\n`);
