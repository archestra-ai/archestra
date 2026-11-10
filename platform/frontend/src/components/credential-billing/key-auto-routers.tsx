"use client";

import type { SupportedProvider } from "@archestra/shared";
import { ChevronDown, Shuffle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useAutoRouters } from "@/lib/auto-routing.query";
import { useFeature } from "@/lib/config/config.query";
import { cn } from "@/lib/utils/tailwind";

const TIERS = [
  { tier: "fast", label: "Fast" },
  { tier: "normal", label: "Normal" },
  { tier: "smart", label: "Smart" },
] as const;

/**
 * The auto routers a virtual key or OAuth client can call, folded under one
 * row like its model pools, with the model each router sends its tiers to.
 * Read-only: routers are managed on the Auto Routing page and added in the
 * credential's dialog. Renders nothing while the organization has no router.
 */
export function KeyAutoRouters({
  virtualApiKeyId,
  routerIds,
  noun = "key",
}: {
  /** The virtual key the routers were added to. */
  virtualApiKeyId?: string;
  /** The routers added to an OAuth client, by id. */
  routerIds?: string[];
  /** What the routers were added to. */
  noun?: "key" | "client";
}) {
  const featureEnabled = useFeature("autoRoutingEnabled") === true;
  const { data: routers = [] } = useAutoRouters({ enabled: featureEnabled });
  const [open, setOpen] = useState(false);
  if (!featureEnabled || routers.length === 0) return null;
  const onKey = routers.filter((router) =>
    virtualApiKeyId
      ? router.virtualApiKeyIds.includes(virtualApiKeyId)
      : (routerIds ?? []).includes(router.id),
  );

  return (
    <div className="space-y-2" data-testid="key-auto-routers">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <p className="text-sm font-medium">Auto routers</p>
        <Button variant="link" size="xs" className="h-auto px-0" asChild>
          <Link href="/llm/auto-routing">Manage auto routers</Link>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        One model name that sends each conversation to a fast, normal or smart
        model, based on what its first message needs.
      </p>
      {onKey.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <Shuffle className="size-4 shrink-0" aria-hidden="true" />
          <span>No auto routers on this {noun}</span>
        </div>
      ) : (
        <Collapsible
          open={open}
          onOpenChange={setOpen}
          className="rounded-md border"
        >
          <CollapsibleTrigger asChild>
            <UnstyledButton className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50">
              <Shuffle
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="flex-1">
                {onKey.length}{" "}
                {onKey.length === 1 ? "auto router" : "auto routers"} on this{" "}
                {noun}
              </span>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-180",
                )}
                aria-hidden="true"
              />
            </UnstyledButton>
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t">
            <ul className="max-h-72 divide-y overflow-y-auto">
              {onKey.map((router) => (
                <li key={router.id} className="space-y-1.5 px-3 py-2">
                  <p className="truncate font-mono text-sm">{router.name}</p>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
                    {TIERS.map(({ tier, label }) => {
                      const model = router.tiers[tier];
                      return (
                        <div key={tier} className="contents">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="flex min-w-0 items-center gap-1.5">
                            {model ? (
                              <>
                                <span aria-hidden className="shrink-0">
                                  <ProviderIcon
                                    provider={
                                      model.provider as SupportedProvider
                                    }
                                    size={14}
                                  />
                                </span>
                                <span className="truncate font-mono">
                                  {model.modelId}
                                </span>
                              </>
                            ) : (
                              <span className="text-muted-foreground">
                                Not set
                              </span>
                            )}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
