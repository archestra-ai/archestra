"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function McpConflictServerList({ names }: { names: string[] }) {
  const remaining = names.slice(3);
  return (
    <span className="font-medium text-foreground">
      <span>{names.slice(0, 3).join(", ")}</span>
      {remaining.length > 0 && (
        <>
          <span>, and </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs font-medium text-inherit underline decoration-dotted underline-offset-4"
              >
                <span>{remaining.length} more</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="start"
              className="max-w-80 px-3 py-2.5"
            >
              <p className="mb-2 font-medium">Other incompatible MCP servers</p>
              <ul className="space-y-1 text-muted-foreground">
                {remaining.map((name) => (
                  <li key={name} className="break-words">
                    {name}
                  </li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </span>
  );
}
