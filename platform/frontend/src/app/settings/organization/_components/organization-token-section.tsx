"use client";

import { Key } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { WithPermissions } from "@/components/roles/with-permissions";
import { TokenManagerDialog } from "@/components/teams/token-manager-dialog";
import { PlatformTokenCard } from "@/components/tokens/platform-token-card";
import { Button } from "@/components/ui/button";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { type TeamToken, useTokens } from "@/lib/teams/team-token.query";

export function OrganizationTokenSection() {
  const { data: tokensData, isLoading: tokensLoading, error } = useTokens();
  const tokens = tokensData?.tokens;
  const orgToken = tokens?.find((t) => t.isOrganizationToken);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const searchParams = useSearchParams();
  const highlight = searchParams.get("highlight");
  const orgTokenExists = !!orgToken;
  const authDocsUrl = getFrontendDocsUrl("mcp-authentication", "bearer-token");

  // Deep link from connection instructions ("Manage your organization
  // token"): ?highlight=organization-token opens the token dialog once the
  // token loads.
  useEffect(() => {
    if (highlight === "organization-token" && orgTokenExists) {
      setTokenDialogOpen(true);
    }
  }, [highlight, orgTokenExists]);

  return (
    <WithPermissions
      permissions={{ team: ["update"] }}
      noPermissionHandle="hide"
    >
      <PlatformTokenCard
        title="Organization Token"
        description={
          <>
            Organization-wide token for calling any Agent through MCP Gateways
            and A2A, not tied to a user or team. It does not grant access to the
            platform API.
            {authDocsUrl && (
              <>
                {" "}
                See{" "}
                <ExternalDocsLink
                  href={authDocsUrl}
                  className="text-inherit underline underline-offset-4"
                  showIcon={false}
                >
                  MCP authentication
                </ExternalDocsLink>
                .
              </>
            )}
          </>
        }
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
          description="Organization-wide token for calling any Agent through MCP Gateways and A2A."
        />
      )}
    </WithPermissions>
  );
}
