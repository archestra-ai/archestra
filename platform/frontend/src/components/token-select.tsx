"use client";

import { type AgentScope, E2eTestId } from "@archestra/shared";
import { RefreshCw } from "lucide-react";
import { useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMcpServersGroupedByCatalog } from "@/lib/mcp/mcp-server.query";
import { cn } from "@/lib/utils";
import Divider from "./divider";
import { LoadingState } from "./loading";

// Special value for dynamic team credential option
export const DYNAMIC_CREDENTIAL_VALUE = "__dynamic__";

interface TokenSelectProps {
  value?: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
  /** Catalog ID to filter credentials - only shows credentials for the same catalog item */
  catalogId: string;
  assignmentScope?: AgentScope;
  assignmentTeamIds?: string[];
  shouldSetDefaultValue: boolean;
  prefersEnterpriseManaged?: boolean;
}

/**
 * Self-contained component for selecting credential source for MCP tool execution.
 * Shows shared organization/team installations. Every personal installation
 * resolves only at call time and can never be pinned to an assignment.
 *
 * Fetches all credentials for the specified catalogId (no agent filtering).
 */
export function TokenSelect({
  value,
  onValueChange,
  disabled,
  className,
  catalogId,
  assignmentScope,
  assignmentTeamIds,
  shouldSetDefaultValue,
  prefersEnterpriseManaged = false,
}: TokenSelectProps) {
  const groupedCredentials = useMcpServersGroupedByCatalog({
    catalogId,
    assignmentScope,
    assignmentTeamIds,
  });

  // Get credentials for this catalogId from the grouped response
  const mcpServers = groupedCredentials?.[catalogId] ?? [];
  const organizationCredentials = mcpServers.filter(
    (server) => server.scope === "org",
  );
  const teamCredentials = mcpServers.filter(
    (server) => server.scope === "team",
  );
  const staticTargets = [...organizationCredentials, ...teamCredentials];

  const isLoading = !groupedCredentials;

  const staticCredentialOutsideOfGroupedCredentials =
    value &&
    value !== DYNAMIC_CREDENTIAL_VALUE &&
    !staticTargets.some((credential) => credential.id === value);

  // biome-ignore lint/correctness/useExhaustiveDependencies: it's expected here to avoid unneeded invocations
  useEffect(() => {
    if (shouldSetDefaultValue && !value) {
      // Resolve-at-call-time is the default; pinning a static credential is an
      // explicit choice.
      onValueChange(DYNAMIC_CREDENTIAL_VALUE);
    }
  }, []);

  if (isLoading) {
    return <LoadingState className="ml-2" variant="inline" />;
  }

  if (staticCredentialOutsideOfGroupedCredentials) {
    return (
      <span className="text-xs text-muted-foreground">
        Connection unavailable for this scope
      </span>
    );
  }

  return (
    <Select
      value={value ?? ""}
      onValueChange={onValueChange}
      disabled={disabled || isLoading}
    >
      <SelectTrigger
        className={cn(
          "h-fit! w-fit! bg-transparent! border-none! shadow-none! ring-0! outline-none! focus:ring-0! focus:outline-none! focus:border-none! p-0! text-xs font-normal",
          className,
        )}
        size="sm"
        data-testid={E2eTestId.TokenSelect}
      >
        <SelectValue placeholder="Select connection..." />
      </SelectTrigger>
      <SelectContent>
        <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
          Dynamic
        </div>
        <SelectItem
          value={DYNAMIC_CREDENTIAL_VALUE}
          className="cursor-pointer"
          description={
            prefersEnterpriseManaged
              ? "Ask your identity provider for a runtime credential for this server."
              : "Follow the server's default credential setting — the caller's own connection, unless the server always uses one account."
          }
        >
          <div className="flex items-center gap-1">
            <RefreshCw className="h-3! w-3! text-muted-foreground" />
            <span>Resolve at call time (Recommended)</span>
          </div>
        </SelectItem>
        {staticTargets.length > 0 ? (
          <>
            {organizationCredentials.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
                  Static - Organization Credentials
                </div>
                {organizationCredentials.map((server) => (
                  <SelectItem
                    key={server.id}
                    value={server.id}
                    className="cursor-pointer"
                    data-testid={E2eTestId.StaticCredentialToUse}
                    description="Available to the organization"
                  >
                    Organization
                  </SelectItem>
                ))}
              </>
            )}
            {organizationCredentials.length > 0 &&
              teamCredentials.length > 0 && <Divider className="my-2" />}
            {teamCredentials.length > 0 && (
              <>
                <div className="px-2 pt-1 pb-1 text-xs text-muted-foreground">
                  Static - Team Credentials
                </div>
                {teamCredentials.map((server) => (
                  <SelectItem
                    key={server.id}
                    value={server.id}
                    className="cursor-pointer"
                    data-testid={E2eTestId.StaticCredentialToUse}
                    description={`Shared with team ${server.teamDetails?.name ?? "Unknown team"}`}
                  >
                    {server.teamDetails?.name ?? "Unknown team"}
                  </SelectItem>
                ))}
              </>
            )}
          </>
        ) : (
          <>
            <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
              Static
            </div>
            <div className="px-2 pb-2 text-xs text-muted-foreground">
              No shared credentials for this server.
            </div>
          </>
        )}
      </SelectContent>
    </Select>
  );
}
