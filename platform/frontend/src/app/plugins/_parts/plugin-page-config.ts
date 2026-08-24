export const PLUGIN_DESCRIPTION_FALLBACK = "No description.";

export const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "copilot-cli": "Copilot CLI",
  codex: "Codex",
  cursor: "Cursor",
};

export const pluginDetailHref = (id: string) => `/plugins/${id}`;
export const pluginEditHref = (id: string) => `/plugins/${id}/edit`;

export function isArchestraPlugin(plugin: {
  sourceMarketplaceRepo?: string | null;
  sourceMarketplacePath?: string | null;
  sourceMarketplacePluginName?: string | null;
}): boolean {
  return (
    plugin.sourceMarketplaceRepo?.toLowerCase() === "archestra-ai/openappa" &&
    plugin.sourceMarketplacePath === ".claude-plugin/marketplace.json" &&
    plugin.sourceMarketplacePluginName?.toLowerCase() === "appa-runtime"
  );
}

export function comparePluginCatalogOrder(
  left: Parameters<typeof isArchestraPlugin>[0] & { displayName: string },
  right: Parameters<typeof isArchestraPlugin>[0] & { displayName: string },
): number {
  const specialOrder =
    Number(isArchestraPlugin(right)) - Number(isArchestraPlugin(left));
  return specialOrder || left.displayName.localeCompare(right.displayName);
}

export function comparePluginRepositoryOrder(left: string, right: string) {
  const isLeftOpenAppa = left.toLowerCase() === "archestra-ai/openappa";
  const isRightOpenAppa = right.toLowerCase() === "archestra-ai/openappa";
  return (
    Number(isRightOpenAppa) - Number(isLeftOpenAppa) ||
    left.localeCompare(right)
  );
}

export function comparePinnedPluginTableOrder(params: {
  left: Parameters<typeof isArchestraPlugin>[0];
  right: Parameters<typeof isArchestraPlugin>[0];
  descending: boolean;
  fallbackResult: number;
}): number {
  const specialOrder =
    Number(isArchestraPlugin(params.right)) -
    Number(isArchestraPlugin(params.left));
  if (specialOrder === 0) return params.fallbackResult;
  // TanStack reverses the sorting function for descending columns. Reverse
  // only the pin here first so OpenAPPA remains above ordinary rows either way.
  return params.descending ? -specialOrder : specialOrder;
}

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

export const PLUGIN_EDIT_STEPS = [
  { id: "content", title: "Content" },
  { id: "access", title: "Access" },
] as const;

export type PluginEditStepId = (typeof PLUGIN_EDIT_STEPS)[number]["id"];

export function resolvePluginEditStep(raw: string | null): PluginEditStepId {
  return raw === "access" ? "access" : "content";
}
