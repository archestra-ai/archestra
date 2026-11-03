import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// One portable JavaScript artifact; Node.js remains an explicit prerequisite.
// This is not a signed installer and does not add a service or save credentials.
await build({
  entryPoints: [fileURLToPath(new URL("./cli.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../../dist/device-mcp-client.mjs", import.meta.url)),
  bundle: true,
  packages: "bundle",
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
