import {
  ARCHESTRA_MCP_CATALOG_ID,
  ARCHESTRA_MCP_SERVER_NAME,
  matchBatteries,
} from "@archestra/shared";
import { BatteryCharging } from "lucide-react";
import {
  siClaude,
  siCloudflare,
  siDatabricks,
  siGithub,
  siGoogle,
  siHuggingface,
  siLinear,
  siNotion,
  siPagerduty,
  siPosthog,
  siSentry,
} from "simple-icons";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { cn } from "@/lib/utils/tailwind";

export type CatalogEntry = {
  id: string;
  name: string;
  icon?: string | null;
  serverUrl?: string | null;
  localConfig?: { dockerImage?: string } | null;
};

/**
 * A battery's mark: the icon of a catalog entry it is installed on, else of one
 * it matches the way "Fits your servers" does or that shares its name, else the
 * bundled provider's, else a battery.
 */
export function BatteryIcon({
  name,
  bundled,
  catalogIds,
  catalog,
  size = 20,
}: {
  name: string;
  bundled: boolean;
  catalogIds: Array<string | null>;
  catalog: CatalogEntry[];
  size?: 16 | 20;
}) {
  const match = catalog
    .flatMap((entry) => {
      if (!entry.icon) return [];
      if (catalogIds.includes(entry.id)) return [{ entry, rank: 0 }];
      const evidence = matchBatteries(entry, new Set([name]))[0]?.evidence;
      if (evidence) return [{ entry, rank: evidence === "name" ? 2 : 1 }];
      // An uploaded battery has no match rule; its catalog entry may share its name.
      return entry.name.toLowerCase() === name.toLowerCase()
        ? [{ entry, rank: 3 }]
        : [];
    })
    .sort((a, b) => a.rank - b.rank)[0]?.entry;
  const providerIcon = BUNDLED_PROVIDER_ICONS[name];
  const box = size === 16 ? "size-4" : "size-5";
  if (match)
    return (
      <McpCatalogIcon icon={match.icon} catalogId={match.id} size={size} />
    );
  // Archestra's own catalog entry has no icon; McpCatalogIcon draws the app logo for its id.
  if (bundled && name === ARCHESTRA_MCP_SERVER_NAME)
    return <McpCatalogIcon catalogId={ARCHESTRA_MCP_CATALOG_ID} size={size} />;
  if (bundled && providerIcon)
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={cn(box, "shrink-0")}
        fill={
          providerIcon.hex === "000000" || providerIcon.hex === "181717"
            ? "currentColor"
            : `#${providerIcon.hex}`
        }
      >
        <path d={providerIcon.path} />
      </svg>
    );
  return (
    <BatteryCharging className={cn(box, "shrink-0 text-muted-foreground")} />
  );
}

const BUNDLED_PROVIDER_ICONS: Record<string, { path: string; hex: string }> = {
  "claude-code": siClaude,
  cloudflare: siCloudflare,
  databricks: siDatabricks,
  github: siGithub,
  "google-workspace": siGoogle,
  huggingface: siHuggingface,
  linear: siLinear,
  notion: siNotion,
  pagerduty: siPagerduty,
  posthog: siPosthog,
  sentry: siSentry,
};
