"use client";

import { archestraApiSdk } from "@archestra/shared";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AccountRow,
  AccountRowMuted,
} from "@/app/account/_components/account-rows";
import { TokenManagerDialog } from "@/components/teams/token-manager-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRotateUserToken, useUserToken } from "@/lib/user-token.query";

/**
 * The personal token MCP and A2A clients use to call agents as you — the one
 * the Connect page's setup snippets embed, and the one chat uses when it runs
 * tools as you. It does not grant access to the platform API (that is API
 * Keys), which the dialog says.
 */
export function GatewayTokenRow() {
  const { data: token, isLoading, error } = useUserToken();
  const rotateMutation = useRotateUserToken();
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const searchParams = useSearchParams();
  const highlight = searchParams.get("highlight");
  const tokenExists = !!token;

  // Deep link from connection instructions ("Manage your personal token"):
  // ?highlight=personal-token opens the token dialog once the token loads.
  useEffect(() => {
    if (highlight === "personal-token" && tokenExists) {
      setTokenDialogOpen(true);
    }
  }, [highlight, tokenExists]);

  return (
    <>
      <AccountRow
        label="Gateway token"
        action={
          token && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setTokenDialogOpen(true)}
            >
              Manage
            </Button>
          )
        }
      >
        {isLoading ? (
          <Skeleton className="h-5 w-40" />
        ) : error ? (
          <span className="text-destructive">
            Couldn't load your token. Try refreshing the page.
          </span>
        ) : token ? (
          <span className="font-mono text-muted-foreground">
            {token.tokenStart}…
          </span>
        ) : (
          <AccountRowMuted>Created automatically on first use</AccountRowMuted>
        )}
      </AccountRow>

      {token && (
        <TokenManagerDialog
          token={token}
          open={tokenDialogOpen}
          onOpenChange={setTokenDialogOpen}
          description="Your personal token for calling Agents you can access through MCP Gateways and A2A. It does not grant access to the platform API."
          fetchTokenValue={async () => {
            const response = await archestraApiSdk.getUserTokenValue();
            return (
              (response.data as { value: string } | undefined)?.value ?? null
            );
          }}
          rotateToken={async () => {
            const result = await rotateMutation.mutateAsync();
            return result?.value ?? null;
          }}
          isRotating={rotateMutation.isPending}
        />
      )}
    </>
  );
}
