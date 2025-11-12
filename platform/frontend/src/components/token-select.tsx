"use client";

import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentAvailableTokens } from "@/lib/mcp-server.query";
import { cn } from "@/lib/utils";

interface TokenSelectProps {
  value?: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
  /** Catalog ID to filter tokens - only shows tokens for the same catalog item */
  catalogId: string;
  /** Agent IDs to filter tokens - only shows tokens that can be used with the specified agents */
  agentIds: string[];
}

/**
 * Self-contained component for selecting credential source for MCP tool execution.
 * Shows team tokens (authType=team) and user tokens (authType=personal) with owner emails.
 *
 * If catalogId is provided, only shows tokens for that specific catalog item.
 * If agentId is provided, only shows tokens that can be used with the specified agents (validates team membership).
 */
export function TokenSelect({
  value,
  onValueChange,
  disabled,
  className,
  catalogId,
  agentIds,
}: TokenSelectProps) {
  const { data: mcpServers, isLoading } = useAgentAvailableTokens({
    agentIds: agentIds ?? null,
    catalogId: catalogId ?? null,
  });

  // Separate team and personal tokens
  const teamTokens = mcpServers?.filter((server) => server.authType === "team");
  const userTokens = mcpServers?.filter(
    (server) => server.authType === "personal",
  );

  // Auto-select if there's only one token available
  useEffect(() => {
    if (!mcpServers || isLoading || value || agentIds.length === 0) return;

    const allTokens = mcpServers?.filter(
      (server) => server.authType === "team" || server.authType === "personal",
    );
    if (allTokens.length === 1) {
      onValueChange(allTokens[0].id);
    }
  }, [mcpServers, agentIds, isLoading, value, onValueChange]);

  return (
    <Select
      value={value || undefined}
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
        <SelectValue placeholder="Select token..." />
      </SelectTrigger>
      <SelectContent>
        {teamTokens && teamTokens.length > 0 && (
          <SelectGroup>
            <SelectLabel>Team tokens</SelectLabel>
            {teamTokens.map((server) => (
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
          </SelectGroup>
        )}

        {userTokens && userTokens.length > 0 && (
          <SelectGroup>
            <SelectLabel>User tokens</SelectLabel>
            {userTokens.map((server) => (
              <SelectItem
                key={server.id}
                value={server.id}
                className="cursor-pointer"
              >
                <span className="text-xs">
                  {server.ownerEmail || "Unknown owner"}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}

        {(!teamTokens || teamTokens.length === 0) &&
          (!userTokens || userTokens.length === 0) && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No tokens available
            </div>
          )}
      </SelectContent>
    </Select>
  );
}
