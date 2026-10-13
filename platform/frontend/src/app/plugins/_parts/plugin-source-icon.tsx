import { DEFAULT_GIT_WEB_URLS, type GitProvider } from "@archestra/shared";
import { Puzzle } from "lucide-react";
import { AgentIcon } from "@/components/agent-icon";
import { RepositoryOwnerIcon } from "@/components/repository-owner-icon";
import { repositoryLabel } from "@/lib/skills/skill-source";

type PluginSource = {
  /** A chosen icon wins over the source mark. */
  icon?: string | null;
  sourceMarketplaceRepo: string | null;
  sourceRepo: string | null;
  sourceProvider?: GitProvider | null;
  sourceOrigin?: string | null;
};

/**
 * The repository a plugin came from: `owner/repo` on github.com, the web URL
 * on every other host, so the same path on two hosts stays distinct.
 */
export function pluginRepository(plugin: PluginSource): string | null {
  const repo = plugin.sourceMarketplaceRepo ?? plugin.sourceRepo;
  if (!repo) return null;
  const origin =
    plugin.sourceOrigin ??
    DEFAULT_GIT_WEB_URLS[plugin.sourceProvider ?? "github"];
  return origin === DEFAULT_GIT_WEB_URLS.github ? repo : `${origin}/${repo}`;
}

export function PluginSourceIcon({ plugin }: { plugin: PluginSource }) {
  const repo = pluginRepository(plugin);
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30 text-muted-foreground"
      aria-hidden
      title={repo ? `Source: ${repositoryLabel(repo)}` : "Manual plugin source"}
    >
      <PluginSourceGlyph plugin={plugin} />
    </span>
  );
}

/**
 * The plugin's chosen icon, else its source mark. Bare, for a container that
 * draws its own tile.
 */
export function PluginSourceGlyph({ plugin }: { plugin: PluginSource }) {
  if (plugin.icon) return <AgentIcon icon={plugin.icon} size={24} />;
  const repo = pluginRepository(plugin);
  return repo ? (
    <RepositoryOwnerIcon
      repo={repo}
      provider={plugin.sourceProvider}
      className="size-6"
    />
  ) : (
    <Puzzle className="size-4 text-muted-foreground" />
  );
}
