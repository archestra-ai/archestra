"use client";

import type { SupportedProvider } from "@archestra/shared";
import { ProviderIcon } from "@/components/provider-icon";
import { OverlappedIcons } from "@/components/ui/overlapped-icons";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import type { ModelPool } from "@/lib/model-pools.query";

/** The providers a pool's members are on, as icons. */
export function PoolProviders({ pool }: { pool: ModelPool }) {
  const catalog = useModelProviderCatalog();
  return (
    <span className="truncate">
      {poolProviders(pool)
        .map((provider) => catalog.label(provider))
        .join(", ")}
    </span>
  );
}

/** The pool's providers as overlapping logos, to tell pools apart at a glance. */
export function PoolProviderIcons({ pool }: { pool: ModelPool }) {
  const catalog = useModelProviderCatalog();
  return (
    <OverlappedIcons
      className="w-14 shrink-0 -space-x-2"
      maxVisible={2}
      itemClassName="size-6"
      icons={poolProviders(pool).map((provider) => ({
        key: provider,
        icon: <ProviderIcon provider={provider} size={14} />,
        tooltip: catalog.label(provider),
      }))}
    />
  );
}

function poolProviders(pool: ModelPool): SupportedProvider[] {
  return [
    ...new Set(
      pool.members.map((member) => member.provider as SupportedProvider),
    ),
  ];
}
