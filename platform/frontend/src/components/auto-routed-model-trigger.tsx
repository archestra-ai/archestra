"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Sparkles } from "lucide-react";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type AutoRoutingTiers =
  archestraApiTypes.GetOrganizationDefaultModelResponses["200"]["autoRouters"][number]["tiers"];

/**
 * The model control of an agent on an auto router, or without a provider key
 * while the organization default is one. It names the router in a
 * few words that never truncate; the tooltip lists the three routed models.
 */
export function AutoRoutedModelTrigger({
  tiers,
  label = "Auto",
}: {
  tiers: AutoRoutingTiers;
  /** The router's label, e.g. "Auto · support". */
  label?: string;
}) {
  const rows = [
    { tier: "Fast", ...tiers.fast },
    { tier: "Normal", ...tiers.normal },
    { tier: "Smart", ...tiers.smart },
  ];
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* aria-disabled rather than disabled, so it still takes focus
              and hover and the tooltip can open. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled
            className="cursor-default gap-2 aria-disabled:cursor-default aria-disabled:opacity-100"
          >
            <Sparkles aria-hidden />
            <span className="text-foreground/80">{label}</span>
            <span className="hidden text-muted-foreground sm:inline">
              3 models
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          className="w-max max-w-none px-3 py-2.5 text-left text-wrap"
        >
          <ul className="space-y-1">
            {rows.map((row) => (
              <li key={row.tier} className="flex items-center gap-2">
                <ModelSelectorLogo
                  provider={row.provider}
                  className="size-3.5"
                />
                <span>{row.displayName}</span>
                <span className="ml-auto pl-4 text-muted-foreground">
                  {row.tier}
                </span>
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
