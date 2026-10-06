export interface PopularPluginMarketplace {
  repo: string;
  description: string;
}

export const PLUGIN_MARKETPLACE_DISCOVERY_LIMIT = 500;
export const PLUGIN_MARKETPLACE_IMPORT_LIMIT = 10;

/** Public marketplaces shown in the Plugin wizard. */
export const POPULAR_PLUGIN_MARKETPLACES: PopularPluginMarketplace[] = [
  {
    repo: "anthropics/claude-plugins-official",
    description: "Anthropic's official plugin marketplace for Claude Code.",
  },
  {
    repo: "anthropics/knowledge-work-plugins",
    description:
      "Knowledge-work plugins from Anthropic (docs, slides, sheets).",
  },
  {
    repo: "github/awesome-copilot",
    description: "GitHub's curated Copilot plugin marketplace.",
  },
  {
    repo: "obra/superpowers-marketplace",
    description: "The Superpowers marketplace - core and community workflows.",
  },
  {
    repo: "obra/superpowers",
    description:
      "Jesse Vincent's Superpowers plugin for Claude Code and Codex.",
  },
  {
    repo: "wshobson/agents",
    description:
      "Production-ready agents and plugins for Claude Code and Codex.",
  },
];
