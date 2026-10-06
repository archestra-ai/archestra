export const PLUGIN_DESCRIPTION_FALLBACK = "No description.";

export const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "copilot-cli": "Copilot CLI",
  codex: "Codex",
  cursor: "Cursor",
};

export const pluginDetailHref = (id: string) => `/plugins/${id}`;
/**
 * Where "edit this plugin" lands. Editing is not a page of its own any more —
 * the plugin's page *is* its settings — so every edit link resolves there.
 */
export const pluginEditHref = (id: string) => pluginDetailHref(id);

export function resolvePluginInstallSelection(
  plugins: readonly {
    clientType: "claude-code" | "codex" | "copilot-cli" | "cursor";
    supportedPlatforms: readonly ("posix" | "windows")[];
    enabled?: boolean;
  }[],
): {
  clientType: "claude-code" | "codex" | "copilot-cli" | "cursor" | null;
  supportedPlatforms: ("posix" | "windows")[];
  error: string | null;
} {
  const clientTypes = new Set(plugins.map((plugin) => plugin.clientType));
  if (clientTypes.size !== 1) {
    return {
      clientType: null,
      supportedPlatforms: [],
      error: "Select plugins for one client at a time",
    };
  }
  if (plugins.some((plugin) => plugin.enabled === false)) {
    return {
      clientType: [...clientTypes][0] ?? null,
      supportedPlatforms: [],
      error: "Disabled plugins cannot be installed",
    };
  }
  const supportedPlatforms = (["posix", "windows"] as const).filter(
    (platform) =>
      plugins.every((plugin) => plugin.supportedPlatforms.includes(platform)),
  );
  return {
    clientType: [...clientTypes][0] ?? null,
    supportedPlatforms,
    error:
      supportedPlatforms.length === 0
        ? "Selected plugins have no common platform"
        : null,
  };
}
