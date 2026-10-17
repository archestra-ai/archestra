"use client";

import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { GatewayToolRow } from "./gateway-tools";
import { useGatewayToolRows } from "./gateway-tools.query";

/**
 * What a gateway exposes, in the one column the list has for it.
 *
 * The column used to render `tools.length`, which is a lie for the default
 * configuration: an Auto-mode gateway has no per-tool rows at all, so it
 * showed "0" while exposing the whole catalogue. It is also a counter with no
 * denominator, which the detail-page rules forbid — and the denominator cannot
 * honestly be named here, because the catalogue a gateway reaches depends on
 * its environment's installs and on its own exclusions, and `GET /api/tools`
 * would pull every tool's JSON schema onto a list page to find out. So the set
 * is named instead of counted, and the list itself is one hover away, which is
 * what the rules say to do when the denominator is unavailable.
 *
 * The list rows carry only the count. The names are read when the tooltip
 * opens, so a page of gateways does not load every assigned tool.
 */
export function ExposedSetCell({
  exposesEverything,
  everythingLabel,
  count,
  noun,
  names,
}: {
  exposesEverything: boolean;
  /** What "everything" is called here — "All tools", "All subagents". */
  everythingLabel: string;
  count: number;
  noun: string;
  /** Loads the names; rendered only while the tooltip is open. */
  names: ReactNode;
}) {
  if (exposesEverything) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-sm">{everythingLabel}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Every {noun} this gateway's environment offers, minus its exclusions.
          The set grows as servers are installed.
        </TooltipContent>
      </Tooltip>
    );
  }

  if (count === 0) {
    return <span className="text-sm text-muted-foreground">None</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-sm">{count} selected</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{names}</TooltipContent>
    </Tooltip>
  );
}

/** One gateway's tool or subagent names, read when its cell's tooltip opens. */
export function ExposedSetNames({
  gatewayId,
  agentTypes,
  status,
  noun,
  pick,
}: {
  gatewayId: string;
  agentTypes: Array<"mcp_gateway" | "profile">;
  status?: "active" | "deleted";
  noun: string;
  pick: (tools: GatewayToolRow[]) => string[];
}) {
  const { data, isPending, isError } = useGatewayToolRows({
    id: gatewayId,
    agentTypes,
    status,
  });
  // Keyed so React swaps the span instead of editing its text in place,
  // which breaks under machine translation (see the frontend skill).
  if (isPending) return <span key="loading">Loading {noun} names…</span>;
  if (isError)
    return (
      <span key="error">Couldn't load {noun} names. Hover again to retry.</span>
    );
  const names = pick(data);
  return <span key="names">{names.length ? names.join(", ") : "None"}</span>;
}
