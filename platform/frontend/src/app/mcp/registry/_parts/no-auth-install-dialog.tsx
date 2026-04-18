"use client";

import type { archestraApiTypes } from "@shared";
import { Building2 } from "lucide-react";
import { useCallback, useState } from "react";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
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
  /** Pre-select a specific team in the credential type selector */
  preselectedTeamId?: string | null;
  /** When true, only personal installation is allowed */
  personalOnly?: boolean;
}

export function NoAuthInstallDialog({
  isOpen,
  onClose,
  onInstall,
  catalogItem,
  isInstalling,
  preselectedTeamId,
  personalOnly = false,
}: NoAuthInstallDialogProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [canInstall, setCanInstall] = useState(true);

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
    <StandardFormDialog
      open={isOpen}
      onOpenChange={handleClose}
      title={
        <span className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          <span>Install {catalogItem.name}</span>
        </span>
      }
      description="This MCP server doesn't require authentication. Click Install to proceed."
      size="medium"
      bodyClassName="space-y-4"
      onSubmit={handleInstall}
      footer={
        canInstall ? (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={isInstalling}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isInstalling}>
              {isInstalling ? "Installing..." : "Install"}
            </Button>
          </>
        ) : null
      }
    >
      <SelectMcpServerCredentialTypeAndTeams
        onTeamChange={setSelectedTeamId}
        catalogId={catalogItem.id}
        onCanInstallChange={setCanInstall}
        preselectedTeamId={preselectedTeamId}
        personalOnly={personalOnly}
      />
    </StandardFormDialog>
  );
}
