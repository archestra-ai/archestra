"use client";

import { type AgentScope, E2eTestId } from "@archestra/shared";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "@/lib/auth/auth.query";
import { useMcpServersGroupedByCatalog } from "@/lib/mcp/mcp-server.query";
import { cn } from "@/lib/utils";
import Divider from "./divider";
import { LoadingSpinner } from "./loading";
import { StaticCredentialConfirmDialog } from "./static-credential-confirm-dialog";

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
  /**
   * Scope of the agent this credential is assigned to. Picking a personal-scope
   * connection for a shared (team/org) agent makes every caller authenticate as
   * that one owner, so it is confirmed on selection. A personal agent is
   * single-user and skips the confirmation. Unknown scope falls to the safe side.
   */
  agentScope?: AgentScope;
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
  assignmentScope,
  assignmentTeamIds,
  shouldSetDefaultValue,
  prefersEnterpriseManaged = false,
  agentScope,
}: TokenSelectProps) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

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
  const userCredentials = mcpServers.filter(
    (server) => server.scope === "personal",
  );

  const isLoading = !groupedCredentials;

  const staticCredentialOutsideOfGroupedCredentials =
    value &&
    value !== DYNAMIC_CREDENTIAL_VALUE &&
    !groupedCredentials?.[catalogId]?.some(
      (credential) => credential.id === value,
    );

  // biome-ignore lint/correctness/useExhaustiveDependencies: it's expected here to avoid unneeded invocations
  useEffect(() => {
    if (shouldSetDefaultValue && !value) {
      // Resolve-at-call-time is the default; pinning a static credential is an
      // explicit choice.
      onValueChange(DYNAMIC_CREDENTIAL_VALUE);
    }
  }, []);

  const [pendingPersonalPin, setPendingPersonalPin] = useState<{
    id: string;
    mcpName: string;
    ownerEmail: string;
    isCurrentUser: boolean;
  } | null>(null);

  // A personal connection pinned to a shared agent authenticates every caller
  // as that one owner; confirm the pick before applying it. A personal agent is
  // single-user, so it skips the gate; unknown scope falls to the safe side.
  const isSharedAgent = agentScope !== "personal";

  const handleSelect = (newValue: string | null) => {
    if (isSharedAgent && newValue && newValue !== DYNAMIC_CREDENTIAL_VALUE) {
      const server = mcpServers.find((s) => s.id === newValue);
      if (server?.scope === "personal") {
        setPendingPersonalPin({
          id: server.id,
          mcpName: server.catalogName ?? server.name,
          ownerEmail: server.ownerEmail || "Deleted user",
          isCurrentUser: !!currentUserId && server.ownerId === currentUserId,
        });
        return;
      }
    }
    onValueChange(newValue);
  };

  if (isLoading) {
    return <LoadingSpinner className="w-3 h-3 inline-block ml-2" />;
  }

  if (staticCredentialOutsideOfGroupedCredentials) {
    return (
      <span className="text-xs text-muted-foreground">
        Connection unavailable for this scope
      </span>
    );
  }

  return (
    <>
      <Select
        value={value ?? ""}
        onValueChange={handleSelect}
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
          {mcpServers.length > 0 ? (
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
              <Divider className="my-2" />
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
              {userCredentials.length > 0 && (
                <>
                  <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
                    Static - User Credentials
                  </div>
                  {userCredentials.map((server) => (
                    <SelectItem
                      key={server.id}
                      value={server.id}
                      className="cursor-pointer"
                      data-testid={E2eTestId.StaticCredentialToUse}
                      description={`Owned by ${server.ownerEmail || "Deleted user"}`}
                    >
                      {server.ownerEmail || "Deleted user"}
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
                No saved credentials for this server.
              </div>
            </>
          )}
        </SelectContent>
      </Select>
      <StaticCredentialConfirmDialog
        open={pendingPersonalPin !== null}
        pins={
          pendingPersonalPin
            ? [
                {
                  mcpName: pendingPersonalPin.mcpName,
                  ownerEmail: pendingPersonalPin.ownerEmail,
                  isCurrentUser: pendingPersonalPin.isCurrentUser,
                },
              ]
            : []
        }
        onConfirm={() => {
          if (pendingPersonalPin) {
            onValueChange(pendingPersonalPin.id);
          }
          setPendingPersonalPin(null);
        }}
        onCancel={() => setPendingPersonalPin(null)}
      />
    </>
  );
}
