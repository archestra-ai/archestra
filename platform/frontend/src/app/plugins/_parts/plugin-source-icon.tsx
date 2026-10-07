import { Puzzle } from "lucide-react";
import { RepositoryOwnerIcon } from "@/components/repository-owner-icon";

type PluginSource = {
  sourceMarketplaceRepo: string | null;
  sourceRepo: string | null;
};

export function PluginSourceIcon({ plugin }: { plugin: PluginSource }) {
  const repo = pluginSourceRepo(plugin);
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30 text-muted-foreground"
      aria-hidden
      title={repo ? `Source: ${repo}` : "Manual plugin source"}
    >
      <PluginSourceGlyph plugin={plugin} />
    </span>
  );
}

/** The bare source mark, for a container that draws its own tile. */
export function PluginSourceGlyph({ plugin }: { plugin: PluginSource }) {
  const repo = pluginSourceRepo(plugin);
  return repo ? (
    <RepositoryOwnerIcon repo={repo} className="size-6" />
  ) : (
    <Puzzle className="size-4 text-muted-foreground" />
  );
}

function pluginSourceRepo(plugin: PluginSource) {
  return plugin.sourceMarketplaceRepo ?? plugin.sourceRepo;
}
