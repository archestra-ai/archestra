"use client";

import { Key } from "lucide-react";
import { useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import { TokenManagerDialog } from "@/components/teams/token-manager-dialog";
import { PlatformTokenCard } from "@/components/tokens/platform-token-card";
import { Button } from "@/components/ui/button";
import { type TeamToken, useTokens } from "@/lib/teams/team-token.query";

export function OrganizationTokenSection() {
  const { data: tokensData, isLoading: tokensLoading, error } = useTokens();
  const tokens = tokensData?.tokens;
  const orgToken = tokens?.find((t) => t.isOrganizationToken);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);

  return (
    <WithPermissions
      permissions={{ team: ["update"] }}
      noPermissionHandle="hide"
    >
      <PlatformTokenCard
        title="Organization Token"
        description="Organization-wide authentication token for Agents / MCP Gateways."
        isLoading={tokensLoading}
        error={error}
        tokenExists={!!orgToken}
        emptyDescription="No organization token available. It will be automatically created."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => setTokenDialogOpen(true)}
          >
            <Key className="h-4 w-4" />
            Manage Token
          </Button>
        }
      />

      {orgToken && (
        <TokenManagerDialog
          token={orgToken as TeamToken}
          open={tokenDialogOpen}
          onOpenChange={setTokenDialogOpen}
          description="Organization-wide token for Agents / MCP Gateways."
        />
      )}
    </WithPermissions>
  );
}
