"use client";

import { Key } from "lucide-react";
import {
  type ManagedPlatformToken,
  PlatformTokenManagerDialog,
} from "@/components/tokens/platform-token-manager-dialog";

interface TokenManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: ManagedPlatformToken;
  description: string;
  fetchTokenValue: () => Promise<string | null>;
  rotateToken: () => Promise<string | null>;
  isRotating: boolean;
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
      description={description}
      fetchTokenValue={fetchTokenValue}
      rotateToken={rotateToken}
      isRotating={isRotating}
    />
  );
}
