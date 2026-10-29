"use client";

import { AppWindow } from "lucide-react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// The app's leading icon (shared by table rows and pinned tiles): the icon set
// on the app itself, or — for an external app — its backing MCP server's
// registry one, both emoji or image. Without one, the glyph says which kind of
// app it is: the app window for an owned app, the server glyph for an external
// one. The label (what "owned" vs "external" means) rides in the tooltip +
// aria-label rather than a separate badge.
export function AppTypeIcon({
  owned,
  icon,
  size = 16,
}: {
  owned: boolean;
  icon?: string | null;
  size?: number;
}) {
  const label = owned ? "MCP app" : "MCP server app";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className="inline-flex text-muted-foreground"
        >
          <McpCatalogIcon
            icon={icon}
            size={size}
            fallback={owned ? AppWindow : undefined}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
