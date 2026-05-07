"use client";

import { archestraApiSdk } from "@shared";
import { Key } from "lucide-react";
import { useState } from "react";
import { TokenManagerDialog } from "@/components/teams/token-manager-dialog";
import { PlatformTokenCard } from "@/components/tokens/platform-token-card";
import { Button } from "@/components/ui/button";
import { useRotateUserToken, useUserToken } from "@/lib/user-token.query";

export function PersonalTokenCard() {
  const { data: token, isLoading, error } = useUserToken();
  const rotateMutation = useRotateUserToken();
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);

  return (
    <>
      <PlatformTokenCard
        title="MCP Gateway/A2A Gateway Token"
        description="Your personal token to authenticate with Agents / MCP Gateways."
        isLoading={isLoading}
        error={error}
        tokenExists={!!token}
        emptyDescription="No personal token available. It will be automatically created."
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

      {token && (
        <TokenManagerDialog
          token={token}
          open={tokenDialogOpen}
          onOpenChange={setTokenDialogOpen}
          description="Personal token for Agents / MCP Gateways you can access."
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
