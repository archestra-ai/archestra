import { createHash } from "node:crypto";
import {
  KILO_CLIENT,
  OPENCODE_CLIENT,
  type OpenCodeFamilyClient,
} from "../opencode-family";
import { openCodeMcpMergeScript } from "./opencode-mcp-config";
import type { ManagedRuntimeCatalog } from "./opencode-primary-config";
import {
  renderOpenCodeRoutingPlugin,
  renderOpenCodeRoutingPluginV2,
} from "./opencode-routing-plugin";

/** No installer replay, personal snapshots, or plaintext credentials in artifacts. */
export function managedRuntimeManifest(params: {
  installation: string;
  clientId: "opencode" | "kilo";
  /** Public catalog only. Credentials are read from the local runtime file. */
  catalog?: ManagedRuntimeCatalog;
}) {
  const client = params.clientId === "kilo" ? KILO_CLIENT : OPENCODE_CLIENT;
  const plugin = {
    client,
    routes: {},
    headers: {},
    runtime: true as const,
    catalog: params.catalog,
  };
  const sources = {
    "launcher.cjs": String.raw`const fs = require("node:fs");
const path = require("node:path");
const { homedir } = require("node:os");
const root = path.dirname(__dirname);
const loader = require(path.join(root, "bootstrap.cjs"));
const repair = require("./repair.cjs");
module.exports.connected = params => {
  const skip = path.join(homedir(), params.skipRelpath);
  return !(fs.existsSync(skip) && fs.readFileSync(skip, "utf8").split(/\r?\n/).includes("mcp"));
};
module.exports.prepare = async (runtime, config) => loader.locked(root, async () => {
  const params = runtime.params;
  if (!module.exports.connected(params)) return false;
  if (params.mcp) {
    if (config) repair.memory(config, params);
    repair.disk(params, loader);
  }
  return true;
});
`,
    "repair.cjs": repairArtifact(client),
    "routing-v1.mjs": renderOpenCodeRoutingPlugin(plugin),
    "routing-v2.mjs": renderOpenCodeRoutingPluginV2(plugin),
  };
  return {
    format: 1 as const,
    installation: params.installation,
    clientId: params.clientId,
    artifacts: Object.fromEntries(
      Object.entries(sources).map(([name, source]) => [
        name,
        {
          source,
          sha256: createHash("sha256").update(source).digest("hex"),
        },
      ]),
    ),
  };
}

function repairArtifact(client: OpenCodeFamilyClient): string {
  // realFs writes the user's files. The fs argument is the in-memory stand-in.
  return `const realFs = require("node:fs");
const path = require("node:path");
const { homedir } = require("node:os");
function reconcile(cfg, configPath, params, fs) {
  // The merge payload's environment contract is scoped to this synchronous call.
  const process = { env: { ARCHESTRA_OC_MCP_NAME: params.mcp.serverName, ARCHESTRA_OC_MCP_URL: params.mcp.url, ARCHESTRA_OC_MCP_DISABLED_FIELD: params.apiMajor === 2 ? "disabled" : "enabled" } };
  ${openCodeMcpMergeScript(client, "repair")}
  return writeMcpSibling;
}
module.exports.memory = (cfg, params) => {
  if (!params.mcp) return;
  // Actual client config already includes project/env overrides: do NOT merge
  // the global sibling over it again, or persist those overrides to global files.
  reconcile(cfg, "memory", params, { existsSync: () => false });
};
module.exports.disk = (params, loader) => {
  const configPath = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), ${JSON.stringify(client.dir)}, ${JSON.stringify(client.configFile)});
  const siblingPath = path.join(path.dirname(configPath), ${JSON.stringify(client.commentedConfigFile)});
  if (realFs.existsSync(path.dirname(configPath))) loader.owned(path.dirname(configPath), true, false);
  const before = new Map();
  for (const file of [configPath, siblingPath]) {
    if (realFs.existsSync(file)) loader.owned(file, false, false);
    before.set(file, realFs.existsSync(file) ? realFs.readFileSync(file, "utf8") : null);
  }
  if (!before.get(configPath) && !before.get(siblingPath)) return;
  const cfg = before.get(configPath)?.trim() ? JSON.parse(before.get(configPath).replace(/^\\uFEFF/, "")) : {};
  const fs = { ...realFs,
    writeFileSync: (file, bytes) => {
      const current = realFs.existsSync(file) ? realFs.readFileSync(file, "utf8") : null;
      if (current !== before.get(file)) throw new Error("MCP config changed during alias repair");
      if (realFs.existsSync(file)) loader.owned(file, false, false);
      loader.atomic(file, bytes);
    },
    copyFileSync: (file, backup) => {
      if (realFs.existsSync(backup)) return;
      realFs.copyFileSync(file, backup, realFs.constants.COPYFILE_EXCL);
      realFs.chmodSync(backup, 0o600);
    },
  };
  const persistSibling = reconcile(cfg, configPath, params, fs);
  const updated = JSON.stringify(cfg, null, 2) + "\\n";
  for (const [file, original] of before) {
    const current = realFs.existsSync(file) ? realFs.readFileSync(file, "utf8") : null;
    if (current !== original) throw new Error("MCP config changed during alias repair");
  }
  if (JSON.stringify(cfg) !== JSON.stringify(before.get(configPath)?.trim() ? JSON.parse(before.get(configPath).replace(/^\\uFEFF/, "")) : {})) {
    const backup = configPath + ".archestra-backup";
    if (realFs.existsSync(configPath) && !realFs.existsSync(backup)) fs.copyFileSync(configPath, backup);
    fs.writeFileSync(configPath, updated);
  }
  // Preserve the payload contract: cfg is durable before modifying its sibling.
  persistSibling();
};
`;
}
