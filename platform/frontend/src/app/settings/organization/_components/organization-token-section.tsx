"use client";

import { Key } from "lucide-react";
import { useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { TokenManagerDialog } from "@/components/teams/token-manager-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { type TeamToken, useTokens } from "@/lib/team-token.query";

export function OrganizationTokenSection() {
  const { data: tokensData, isLoading: tokensLoading } = useTokens();
  const tokens = tokensData?.tokens;
  const [selectedToken, setSelectedToken] = useState<TeamToken | null>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);

  return (
    <WithPermissions
      permissions={{ team: ["update"] }}
      noPermissionHandle="hide"
    >
      <Card>
        <SettingsCardHeader
          title="Organization Token"
          description="Organization-wide authentication token for MCP Gateway access"
        />
        <CardContent>
          {tokensLoading ? (
            <p className="text-sm text-muted-foreground">Loading token...</p>
          ) : (
            (() => {
              const orgToken = tokens?.find((t) => t.isOrganizationToken);
              if (!orgToken) {
                return (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <Key className="mb-4 h-12 w-12 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      No organization token available. It will be automatically
                      created.
                    </p>
                  </div>
                );
              }
              return (
                <div className="flex flex-col md:flex-row md:items-center md:justify-between rounded-lg border p-4 gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-sm text-muted-foreground truncate">
                      {orgToken.tokenStart}...
                    </p>
                  </div>
                  <PermissionButton
                    permissions={{ team: ["update"] }}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedToken(orgToken);
                      setTokenDialogOpen(true);
                    }}
                  >
                    <Key className="mr-2 h-4 w-4" />
                    Manage Token
                  </PermissionButton>
                </div>
              );
            })()
          )}
        </CardContent>
      </Card>

      {selectedToken && (
        <TokenManagerDialog
          token={selectedToken}
          open={tokenDialogOpen}
          onOpenChange={(open) => {
            setTokenDialogOpen(open);
            if (!open) setSelectedToken(null);
          }}
        />
      )}
    </WithPermissions>
  );
}
