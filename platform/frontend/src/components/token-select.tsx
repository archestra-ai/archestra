"use client";

import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";
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

interface TokenSelectProps {
  value?: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
  /** Catalog ID to filter tokens - only shows tokens for the same catalog item */
  catalogId?: string | null;
}

/**
 * Self-contained component for selecting credential source for MCP tool execution.
 * Shows team tokens (authType=team) and user tokens (authType=personal) with owner emails.
 *
 * If catalogId is provided, only shows tokens for that specific catalog item.
 */
export function TokenSelect({
  value,
  onValueChange,
  disabled,
  className,
  catalogId,
}: TokenSelectProps) {
  const { data: allMcpServers, isLoading } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: async () => {
      const response = await archestraApiSdk.getMcpServers({});
      return response.data ?? [];
    },
  });

  // Filter to only show tokens for the same catalog item
  const mcpServers = catalogId
    ? allMcpServers?.filter((server) => server.catalogId === catalogId)
    : allMcpServers;

  // Separate team and personal tokens
  const teamTokens = mcpServers?.filter((server) => server.authType === "team");
  const userTokens = mcpServers?.filter(
    (server) => server.authType === "personal",
  );

  return (
    <Select
      value={value || undefined}
      onValueChange={onValueChange}
      disabled={disabled || isLoading}
    >
      <SelectTrigger className={className}>
        <SelectValue placeholder="Select token..." />
      </SelectTrigger>
      <SelectContent>
        {teamTokens && teamTokens.length > 0 && (
          <SelectGroup>
            <SelectLabel>Team tokens</SelectLabel>
            {teamTokens.map((server) => (
              <SelectItem key={server.id} value={server.id}>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
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
              <SelectItem key={server.id} value={server.id}>
                <span className="text-sm">
                  {server.ownerEmail || "Unknown owner"}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}

        {(!teamTokens || teamTokens.length === 0) &&
          (!userTokens || userTokens.length === 0) && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              No tokens available
            </div>
          )}
      </SelectContent>
    </Select>
  );
}
