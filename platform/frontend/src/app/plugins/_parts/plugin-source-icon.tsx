import { Puzzle } from "lucide-react";
import { RepositoryOwnerIcon } from "@/components/repository-owner-icon";

export function PluginSourceIcon({
  plugin,
}: {
  plugin: {
    sourceMarketplaceRepo: string | null;
    sourceRepo: string | null;
  };
}) {
  const repo = plugin.sourceMarketplaceRepo ?? plugin.sourceRepo;
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30 text-muted-foreground"
      aria-hidden
      title={repo ? `Source: ${repo}` : "Manual plugin source"}
    >
      {repo ? (
        <RepositoryOwnerIcon repo={repo} className="size-6" />
      ) : (
        <Puzzle className="size-4" />
      )}
    </span>
  );
}
