"use client";

import type { archestraApiTypes } from "@shared";
import { Building2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SelectMcpServerCredentialTypeAndTeams } from "./select-mcp-server-credential-type-and-teams";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export interface NoAuthInstallResult {
  /** Team ID to assign the MCP server to (null for personal) */
  teamId?: string | null;
}

interface NoAuthInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onInstall: (result: NoAuthInstallResult) => Promise<void>;
  catalogItem: CatalogItem | null;
  isInstalling: boolean;
}

export function NoAuthInstallDialog({
  isOpen,
  onClose,
  onInstall,
  catalogItem,
  isInstalling,
}: NoAuthInstallDialogProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  const handleInstall = useCallback(async () => {
    await onInstall({ teamId: selectedTeamId });
  }, [onInstall, selectedTeamId]);

  const handleClose = useCallback(() => {
    setSelectedTeamId(null);
    onClose();
  }, [onClose]);

  if (!catalogItem) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            <span>Install {catalogItem.name}</span>
          </DialogTitle>
          <DialogDescription>
            This MCP server doesn't require authentication. Click Install to
            proceed.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <SelectMcpServerCredentialTypeAndTeams
            onTeamChange={setSelectedTeamId}
            catalogId={catalogItem?.id}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isInstalling}
          >
            Cancel
          </Button>
          <Button onClick={handleInstall} disabled={isInstalling}>
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
