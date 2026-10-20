"use client";

import { AppWindow, Bot, Boxes, type LucideIcon } from "lucide-react";
import { AgentIdenticon } from "@/app/llm/logs/_parts/hue-avatar";
import { cn } from "@/lib/utils/tailwind";
import type { GatewayOption, McpToolCallRow } from "./types";

/** The gateway, agent, or app the call went through, on its hue tile. */
export function GatewayCell({
  row,
  gateway,
}: {
  row: McpToolCallRow;
  gateway: GatewayOption | undefined;
}) {
  // App-owned calls have no agent by design — attribute them to the app
  // instead of falling through to the deleted-gateway label.
  const isApp = row.ownerType === "app";
  const isDeleted = isApp ? !row.appName : !gateway && row.agentId === null;
  const name = isApp
    ? (row.appName ?? "Deleted app")
    : (gateway?.name ??
      (row.agentId === null ? "Deleted MCP gateway" : "Unknown gateway"));
  const kind: GatewayKind = isApp
    ? "app"
    : gateway?.agentType === "agent"
      ? "agent"
      : "gateway";
  const { icon: KindIcon, label } = GATEWAY_KINDS[kind];

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <AgentIdenticon
        seed={row.agentId ?? row.appId ?? name}
        name={name}
        variant={isDeleted ? "deleted" : "agent"}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-sm leading-5 font-medium",
            isDeleted && "font-normal text-muted-foreground",
          )}
          title={name}
        >
          {name}
        </div>
        <div className="flex h-4 min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
          <KindIcon className="size-3 shrink-0 opacity-70" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

type GatewayKind = "gateway" | "agent" | "app";

const GATEWAY_KINDS: Record<GatewayKind, { icon: LucideIcon; label: string }> =
  {
    gateway: { icon: Boxes, label: "MCP gateway" },
    agent: { icon: Bot, label: "Agent" },
    app: { icon: AppWindow, label: "App" },
  };
