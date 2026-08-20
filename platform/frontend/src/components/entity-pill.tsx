import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The chip the wizard and the detail pages both name things with — an MCP
 * server, an agent, a skill, a knowledge source. `count` is the wizard's
 * "(N)" and `note` its trailing detail ("78/98 disabled"); an `exclude` tone
 * carries the tool editor's red dot.
 */
export function EntityPill({
  icon,
  name,
  count,
  note,
  tone,
}: {
  icon?: ReactNode;
  name: string;
  count?: number;
  note?: string;
  tone?: "exclude";
}) {
  return (
    <span className="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-3 text-xs">
      {tone === "exclude" && (
        <span className="size-2 shrink-0 rounded-full bg-red-500" />
      )}
      {icon}
      <span className="min-w-0 truncate font-medium">{name}</span>
      {count !== undefined && (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          ({count})
        </span>
      )}
      {note && (
        <span className={cn("shrink-0 font-normal text-muted-foreground")}>
          {note}
        </span>
      )}
    </span>
  );
}
