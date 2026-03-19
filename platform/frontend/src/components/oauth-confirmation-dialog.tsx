"use client";

import { AlertCircle, ShieldCheck, User } from "lucide-react";
import { useState } from "react";
import { SelectMcpServerCredentialTypeAndTeams } from "@/app/mcp/registry/_parts/select-mcp-server-credential-type-and-teams";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFeature } from "@/lib/config.query";

export interface OAuthInstallResult {
  /** Team ID to assign the MCP server to (null for personal) */
  teamId?: string | null;
}

interface OAuthConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  onConfirm: (result: OAuthInstallResult) => void;
  onCancel: () => void;
  /** Catalog ID to filter existing installations */
  catalogId?: string;
  /** Pre-select a specific team in the credential type selector */
  preselectedTeamId?: string | null;
  /** When true, only personal installation is allowed */
  personalOnly?: boolean;
}

export function OAuthConfirmationDialog({
  open,
  onOpenChange,
  serverName,
  onConfirm,
  onCancel,
  catalogId,
  preselectedTeamId,
  personalOnly = false,
}: OAuthConfirmationDialogProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [canInstall, setCanInstall] = useState(true);
  const byosEnabled = useFeature("byosEnabled");

  const handleConfirm = () => {
    onConfirm({ teamId: selectedTeamId });
    onOpenChange(false);
  };

  const handleCancel = () => {
    setSelectedTeamId(null);
    onCancel();
    onOpenChange(false);
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <User className="h-5 w-5" />
            <span>OAuth Authorization</span>
            <Badge variant="secondary" className="ml-2 flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" />
              OAuth
            </Badge>
            <span className="text-muted-foreground ml-2 font-normal">
              {serverName}
            </span>
          </div>
        </div>
      }
      description={`We'll redirect you to ${serverName} to authorize access, then bring you back once connected.`}
      size="medium"
      bodyClassName="space-y-4"
      onSubmit={handleConfirm}
      footer={
        canInstall ? (
          <>
            <Button type="button" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-blue-600 text-white hover:bg-blue-700"
            >
              Continue to Authorization...
            </Button>
          </>
        ) : null
      }
    >
      {canInstall && byosEnabled ? (
        <Alert
          variant="default"
          className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20"
        >
          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-500" />
          <AlertDescription className="text-amber-700 dark:text-amber-400">
            Read-only Vault Secret Manager doesn't support OAuth credentials.
            They will be stored in the database.
          </AlertDescription>
        </Alert>
      ) : null}

      <SelectMcpServerCredentialTypeAndTeams
        onTeamChange={setSelectedTeamId}
        catalogId={catalogId}
        onCanInstallChange={setCanInstall}
        preselectedTeamId={preselectedTeamId}
        personalOnly={personalOnly}
      />
    </StandardFormDialog>
  );
}
