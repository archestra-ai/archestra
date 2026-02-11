"use client";

import { AlertCircle, ShieldCheck, User } from "lucide-react";
import { useState } from "react";
import { SelectMcpServerCredentialTypeAndTeams } from "@/app/mcp-catalog/_parts/select-mcp-server-credential-type-and-teams";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFeatureFlag } from "@/lib/features.hook";

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
}

export function OAuthConfirmationDialog({
  open,
  onOpenChange,
  serverName,
  onConfirm,
  onCancel,
  catalogId,
}: OAuthConfirmationDialogProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const byosEnabled = useFeatureFlag("byosEnabled");

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <User className="h-5 w-5" />
              <span>OAuth Authorization</span>
              <Badge
                variant="secondary"
                className="flex items-center gap-1 ml-2"
              >
                <ShieldCheck className="h-3 w-3" />
                OAuth
              </Badge>
              <span className="text-muted-foreground ml-2 font-normal">
                {serverName}
              </span>
            </div>
          </DialogTitle>
          <DialogDescription className="pt-4 space-y-3 text-sm">
            You'll be redirected to {serverName}'s authorization page to grant
            access. After authentication, you'll be brought back here and the
            server will be installed with your credentials.
          </DialogDescription>
        </DialogHeader>

        {byosEnabled && (
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
        )}

        <div className="py-4">
          <SelectMcpServerCredentialTypeAndTeams
            onTeamChange={setSelectedTeamId}
            catalogId={catalogId}
          />
        </div>

        <DialogFooter className="gap-3 sm:gap-3">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            Continue to Authorization...
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
