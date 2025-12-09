"use client";

import { E2eTestId } from "@shared";
import { Zap } from "lucide-react";
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
import Divider from "./divider";
import { LoadingSpinner } from "./loading";
import { DYNAMIC_CREDENTIAL_VALUE } from "./token-select";

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
  const { data: groupedInstallations, isLoading } = useProfileAvailableTokens({
    catalogId,
  });

  const staticCredentialOutsideOfGroupedInstallations =
    value &&
    value !== DYNAMIC_CREDENTIAL_VALUE &&
    !groupedInstallations?.[catalogId]?.some(
      (installation) => installation.id === value,
    );

  // Get tokens for this catalogId from the grouped response
  const installations = groupedInstallations?.[catalogId] ?? [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: it's expected here to avoid unneeded invocations
  useEffect(() => {
    if (shouldSetDefaultValue && !value) {
      // Default to dynamic credential
      onValueChange(DYNAMIC_CREDENTIAL_VALUE);
    }
  }, []);

  if (isLoading) {
    return <LoadingSpinner className="w-3 h-3 inline-block ml-2" />;
  }

  if (staticCredentialOutsideOfGroupedInstallations) {
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
      data-testid={E2eTestId.InstallationSelect}
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
        <SelectItem value={DYNAMIC_CREDENTIAL_VALUE} className="cursor-pointer">
          <div className="flex items-center gap-1">
            <Zap className="h-3! w-3! text-amber-500" />
            <span className="text-xs font-medium">Resolve at call time</span>
          </div>
        </SelectItem>
        <Divider className="my-2" />
        <div className="text-xs text-muted-foreground ml-2">
          Static credentials
        </div>
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
      </SelectContent>
    </Select>
  );
}
