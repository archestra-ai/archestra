"use client";

import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProfileAvailableTokens } from "@/lib/mcp-server.query";
import { cn } from "@/lib/utils";
import { LoadingSpinner } from "./loading";

interface InstallationSelectProps {
  value?: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
  /** Catalog ID to filter installations - only shows local installations for the same catalog item */
  catalogId: string;
  shouldSetDefaultValue: boolean;
}

/**
 * Self-contained component for selecting execution source (pod) for local MCP tool execution.
 * Shows local MCP server installations for a given catalog item.
 *
 * Fetches all installations for the specified catalogId (no agent filtering).
 */
export function InstallationSelect({
  value,
  onValueChange,
  disabled,
  className,
  catalogId,
  shouldSetDefaultValue,
}: InstallationSelectProps) {
  const { data: groupedTokens, isLoading } = useProfileAvailableTokens({
    catalogId,
  });

  // Get tokens for this catalogId from the grouped response
  const mcpServers = groupedTokens?.[catalogId] ?? [];

  // Filter to local servers only
  const installations = mcpServers.filter(
    (server) => server.serverType === "local",
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: it's expected here to avoid unneeded invocations
  useEffect(() => {
    if (shouldSetDefaultValue && installations.length > 0 && !value) {
      onValueChange(installations[0].id);
    }
  }, [installations.length]);

  if (!installations || installations.length === 0) {
    return (
      <div className="px-2 py-1.5 text-xs text-muted-foreground">
        No installations available
      </div>
    );
  }
  if (isLoading) {
    return <LoadingSpinner className="w-3 h-3 inline-block ml-2" />;
  }

  return (
    <Select
      value={value ?? ""}
      onValueChange={onValueChange}
      disabled={disabled || isLoading}
    >
      <SelectTrigger
        className={cn(
          "h-fit! w-fit! bg-transparent! border-none! shadow-none! ring-0! outline-none! focus:ring-0! focus:outline-none! focus:border-none! p-0!",
          className,
        )}
        size="sm"
      >
        <SelectValue placeholder="Select installation..." />
      </SelectTrigger>
      <SelectContent>
        {installations.map((server) => (
          <SelectItem
            key={server.id}
            value={server.id}
            className="cursor-pointer"
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-xs">
                  {server.ownerEmail || "Unknown owner"}
                </span>
              </div>
              {server.teamDetails && server.teamDetails.length > 0 && (
                <div className="flex gap-1 flex-wrap">
                  {server.teamDetails.map((team) => (
                    <Badge
                      key={team.teamId}
                      variant="secondary"
                      className="text-xs"
                    >
                      {team.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </SelectItem>
        ))}
        {installations.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No installations available
          </div>
        )}
      </SelectContent>
    </Select>
  );
}
