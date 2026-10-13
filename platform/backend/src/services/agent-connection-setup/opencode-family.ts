/**
 * OpenCode and Kilo Code's CLI, an OpenCode fork, take the same setup: the
 * same config keys, `mcp` commands, plugin hooks and session headers. These
 * are the parts that differ: where each keeps its files, its binary, and the
 * names it reads.
 */
export interface OpenCodeFamilyClient {
  clientId: "opencode" | "kilo";
  label: string;
  binary: string;
  /**
   * Folder under XDG_CONFIG_HOME for config, plugins and skills, and under
   * XDG_DATA_HOME for the client's auth store.
   */
  dir: string;
  /** The global config file setup writes in that folder (plain JSON). */
  configFile: string;
  schemaUrl: string;
  /** Prefix of the files setup keeps in ~/.archestra. */
  stateName: string;
  /** Env var that adds inline config at launch; it loads the handoff plugin. */
  inlineConfigEnv: string;
  /**
   * OpenCode 2 replaced the plugin API, so setup reads `opencode --version`.
   * Kilo Code keeps OpenCode 1's plugin API at every version.
   */
  versionedPluginApi: boolean;
}

export const OPENCODE_CLIENT: OpenCodeFamilyClient = {
  clientId: "opencode",
  label: "OpenCode",
  binary: "opencode",
  dir: "opencode",
  configFile: "opencode.json",
  schemaUrl: "https://opencode.ai/config.json",
  stateName: "opencode",
  inlineConfigEnv: "OPENCODE_CONFIG_CONTENT",
  versionedPluginApi: true,
};

// Kilo also reads kilo.jsonc, where `kilo mcp add` writes. Setup writes
// kilo.json so it never rewrites a commented file; Kilo merges both.
export const KILO_CLIENT: OpenCodeFamilyClient = {
  clientId: "kilo",
  label: "Kilo Code",
  binary: "kilo",
  dir: "kilo",
  configFile: "kilo.json",
  schemaUrl: "https://app.kilo.ai/config.json",
  stateName: "kilo",
  inlineConfigEnv: "KILO_CONFIG_CONTENT",
  versionedPluginApi: false,
};
