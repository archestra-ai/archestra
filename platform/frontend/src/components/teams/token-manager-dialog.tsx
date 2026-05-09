"use client";

import { archestraApiSdk } from "@shared";
import { Key } from "lucide-react";
import {
  type ManagedPlatformToken,
  PlatformTokenManagerDialog,
} from "@/components/tokens/platform-token-manager-dialog";
import { type TeamToken, useRotateToken } from "@/lib/teams/team-token.query";

interface TokenManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: TeamToken | ManagedPlatformToken;
  description?: string;
  fetchTokenValue?: () => Promise<string | null>;
  rotateToken?: () => Promise<string | null>;
  isRotating?: boolean;
}

export function TokenManagerDialog({
  open,
  onOpenChange,
  token,
  description,
  fetchTokenValue,
  rotateToken,
  isRotating,
}: TokenManagerDialogProps) {
  const rotateMutation = useRotateToken();

  return (
    <PlatformTokenManagerDialog
      open={open}
      onOpenChange={onOpenChange}
      token={token}
      title={
        <span className="flex items-center gap-2">
          <Key className="h-5 w-5" />
          {token.name}
        </span>
      }
      description={description ?? getDefaultDescription(token)}
      fetchTokenValue={
        fetchTokenValue ??
        (async () => {
          if (!("isOrganizationToken" in token)) return null;
          const response = await archestraApiSdk.getTokenValue({
            path: { tokenId: token.id },
          });
          return (
            (response.data as { value: string } | undefined)?.value ?? null
          );
        })
      }
      rotateToken={
        rotateToken ??
        (async () => {
          const result = await rotateMutation.mutateAsync(token.id);
          return result?.value ?? null;
        })
      }
      isRotating={isRotating ?? rotateMutation.isPending}
    />
  );
}

function getDefaultDescription(token: TeamToken | ManagedPlatformToken) {
  if (!("isOrganizationToken" in token)) {
    return "Token access";
  }

  if (token.isOrganizationToken) {
    return "Organization-wide token for Agents / MCP Gateways.";
  }

  return token.teamId
    ? `Token for ${token.team?.name || "team"} access.`
    : "Team access token.";
}
