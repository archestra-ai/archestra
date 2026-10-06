import { BatteryCharging } from "lucide-react";
import {
  siCloudflare,
  siDatabricks,
  siGithub,
  siHuggingface,
  siLinear,
  siNotion,
  siPagerduty,
  siPosthog,
} from "simple-icons";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { cn } from "@/lib/utils/tailwind";

export type CatalogEntry = { id: string; name: string; icon?: string | null };

/** A battery's mark: its catalog entry's icon, else the bundled provider's, else a battery. */
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
  const match = catalog.find(
    (entry) =>
      catalogIds.includes(entry.id) ||
      entry.name.toLowerCase() === name.toLowerCase(),
  );
  const providerIcon = BUNDLED_PROVIDER_ICONS[name];
  const box = size === 16 ? "size-4" : "size-5";
  if (match?.icon)
    return (
      <McpCatalogIcon icon={match.icon} catalogId={match.id} size={size} />
    );
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
  cloudflare: siCloudflare,
  databricks: siDatabricks,
  github: siGithub,
  huggingface: siHuggingface,
  linear: siLinear,
  notion: siNotion,
  pagerduty: siPagerduty,
  posthog: siPosthog,
};
