import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve("smol-toml"), "utf8");
const output = `export const GROK_TOML = ${JSON.stringify(`const grokToml = (() => { const exports = {};\n${source}\nreturn exports; })();`)};\n`;
writeFileSync(new URL("../src/services/agent-connection-setup/payloads/grok-toml.generated.ts", import.meta.url), output);
