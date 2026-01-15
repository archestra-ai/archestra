"use client";

import { E2eTestId } from "@shared";
import { Zap } from "lucide-react";
import { useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMcpServersGroupedByCatalog } from "@/lib/mcp-server.query";
import { cn } from "@/lib/utils";
import Divider from "./divider";
import { LoadingSpinner } from "./loading";

// Special value for dynamic team credential option
export const DYNAMIC_CREDENTIAL_VALUE = "__dynamic__";

interface TokenSelectProps {
  value?: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
  /** Catalog ID to filter credentials - only shows credentials for the same catalog item */
  catalogId: string;
  shouldSetDefaultValue: boolean;
}

/**
 * Self-contained component for selecting credential source for MCP tool execution.
 * Shows all available credentials with their owner emails and team assignments.
 *
 * Fetches all credentials for the specified catalogId (no agent filtering).
 */
export function TokenSelect({
  value,
  onValueChange,
  disabled,
  className,
  catalogId,
  shouldSetDefaultValue,
}: TokenSelectProps) {
  const groupedCredentials = useMcpServersGroupedByCatalog({ catalogId });

  // Get credentials for this catalogId from the grouped response
  const mcpServers = groupedCredentials?.[catalogId] ?? [];

  // useMcpServersGroupedByCatalog uses useSuspenseQuery, so no loading state needed
  const isLoading = false;

  const staticCredentialOutsideOfGroupedCredentials =
    value &&
    value !== DYNAMIC_CREDENTIAL_VALUE &&
    !groupedCredentials?.[catalogId]?.some(
      (credential) => credential.id === value,
    );

  // biome-ignore lint/correctness/useExhaustiveDependencies: it's expected here to avoid unneeded invocations
  useEffect(() => {
    if (shouldSetDefaultValue && !value) {
      if (mcpServers.length > 0) {
        // Default to the first credential
        onValueChange(mcpServers[0].id);
      } else {
        // Default to dynamic credential when no static credentials available
        onValueChange(DYNAMIC_CREDENTIAL_VALUE);
      }
    }
  }, []);

  if (isLoading) {
    return <LoadingSpinner className="w-3 h-3 inline-block ml-2" />;
  }

  if (staticCredentialOutsideOfGroupedCredentials) {
    return (
      <span className="text-xs text-muted-foreground">
        Owner outside your team
      </span>
    );
  }

  return (
    <Select
      value={value ?? ""}
      onValueChange={onValueChange}
      disabled={disabled || isLoading}
      data-testid={E2eTestId.TokenSelect}
    >
      <SelectTrigger
        className={cn(
          "h-fit! w-fit! bg-transparent! border-none! shadow-none! ring-0! outline-none! focus:ring-0! focus:outline-none! focus:border-none! p-0!",
          className,
        )}
        size="sm"
      >
        <SelectValue placeholder="Select credentials..." />
      </SelectTrigger>
      <SelectContent>
        {mcpServers.length > 0 && (
          <>
            <div className="text-xs text-muted-foreground ml-2">
              Static credentials
            </div>
            {mcpServers.map((server) => (
              <SelectItem
                key={server.id}
                value={server.id}
                className="cursor-pointer"
                data-testid={E2eTestId.StaticCredentialToUse}
              >
                <div className="flex flex-col gap-1">
                  <div className="flex gap-1 flex-wrap text-xs">
                    {server.teamDetails
                      ? server.teamDetails.name
                      : server.ownerEmail || "Unknown"}
                  </div>
                </div>
              </SelectItem>
            ))}
            <Divider className="my-2" />
          </>
        )}
        <SelectItem value={DYNAMIC_CREDENTIAL_VALUE} className="cursor-pointer">
          <div className="flex items-center gap-1">
            <Zap className="h-3! w-3! text-amber-500" />
            <span className="text-xs font-medium">Resolve at call time</span>
          </div>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
