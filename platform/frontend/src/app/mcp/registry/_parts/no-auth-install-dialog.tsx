"use client";

import type { archestraApiTypes } from "@shared";
import { Building2 } from "lucide-react";
import { useCallback, useState } from "react";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  type McpServerInstallScope,
  SelectMcpServerCredentialTypeAndTeams,
} from "./select-mcp-server-credential-type-and-teams";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export interface NoAuthInstallResult {
  /** Installation scope (personal, team, org) */
  scope: McpServerInstallScope;
  /** Team ID to assign the MCP server to (only when scope is "team") */
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
  /** When true, only organization-wide installation is allowed */
  orgOnly?: boolean;
}

export function NoAuthInstallDialog({
  isOpen,
  onClose,
  onInstall,
  catalogItem,
  isInstalling,
  preselectedTeamId,
  personalOnly = false,
  orgOnly = false,
}: NoAuthInstallDialogProps) {
  const [scope, setScope] = useState<McpServerInstallScope>(
    orgOnly ? "org" : preselectedTeamId ? "team" : "personal",
  );
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(
    preselectedTeamId ?? null,
  );
  const [canInstall, setCanInstall] = useState(true);

  const handleInstall = useCallback(async () => {
    await onInstall({ scope, teamId: selectedTeamId });
  }, [onInstall, scope, selectedTeamId]);

  const handleClose = useCallback(() => {
    setSelectedTeamId(null);
    setScope("personal");
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
        onScopeChange={setScope}
        catalogId={catalogItem.id}
        onCanInstallChange={setCanInstall}
        preselectedTeamId={preselectedTeamId}
        personalOnly={personalOnly}
        orgOnly={orgOnly}
      />
    </StandardFormDialog>
  );
}
