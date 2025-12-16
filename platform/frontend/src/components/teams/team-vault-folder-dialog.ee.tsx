"use client";

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Trash2,
  Vault,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFeatureFlag, useFeatureValue } from "@/lib/features.hook";
import {
  useCheckTeamVaultFolderConnectivity,
  useDeleteTeamVaultFolder,
  useSetTeamVaultFolder,
  useTeamVaultFolder,
} from "@/lib/team-vault-folder.query.ee";

interface Team {
  id: string;
  name: string;
  description: string | null;
}

interface TeamVaultFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: Team;
}

export default function TeamVaultFolderDialog({
  open,
  onOpenChange,
  team,
}: TeamVaultFolderDialogProps) {
  const [vaultPath, setVaultPath] = useState("");
  const [connectivityResult, setConnectivityResult] = useState<{
    connected: boolean;
    secretCount: number;
    error?: string;
  } | null>(null);

  const byosEnabled = useFeatureFlag("byosEnabled");
  const vaultKvVersion = useFeatureValue("byosVaultKvVersion");
  const { data: existingFolder, isLoading } = useTeamVaultFolder(
    open ? team.id : null,
  );
  const setFolderMutation = useSetTeamVaultFolder();
  const deleteFolderMutation = useDeleteTeamVaultFolder();
  const checkConnectivityMutation = useCheckTeamVaultFolderConnectivity();

  // Initialize vault path from existing folder
  useEffect(() => {
    if (existingFolder?.vaultPath) {
      setVaultPath(existingFolder.vaultPath);
    } else {
      setVaultPath("");
    }
    setConnectivityResult(null);
  }, [existingFolder]);

  const handleSave = async () => {
    const trimmed = vaultPath.trim();
    if (!trimmed) return;

    await setFolderMutation.mutateAsync({
      teamId: team.id,
      vaultPath: trimmed,
    });
    setConnectivityResult(null);
  };

  const handleDelete = async () => {
    await deleteFolderMutation.mutateAsync(team.id);
    setVaultPath("");
    setConnectivityResult(null);
  };

  const handleCheckConnectivity = async () => {
    setConnectivityResult(null);
    const pathToTest = vaultPath.trim();
    try {
      const result = await checkConnectivityMutation.mutateAsync({
        teamId: team.id,
        vaultPath: pathToTest,
      });
      setConnectivityResult(result);
    } catch (error) {
      setConnectivityResult({
        connected: false,
        secretCount: 0,
        error: error instanceof Error ? error.message : "Connection failed",
      });
    }
  };

  // Readonly Vault feature requires both enterprise license and ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT
  if (!byosEnabled) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[550px]">
          <DialogHeader>
            <DialogTitle>Team Vault Folder</DialogTitle>
            <DialogDescription>
              Connect a HashiCorp Vault folder to enable team secrets
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Readonly Vault Not Enabled</AlertTitle>
              <AlertDescription>
                Team Vault Folders require Readonly Vault to be enabled. Contact
                your administrator to configure
                ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT with an enterprise
                license.
              </AlertDescription>
            </Alert>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const hasExistingFolder = !!existingFolder?.vaultPath;
  const hasChanges =
    vaultPath.trim() !== (existingFolder?.vaultPath || "").trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Team Vault Folder</DialogTitle>
          <DialogDescription>
            Connect a HashiCorp Vault folder to "{team.name}" to allow team
            members to use secrets from your external Vault when installing MCP
            servers.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {isLoading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : (
            <>
              {/* Vault path input */}
              <div className="space-y-2">
                <Label htmlFor="vault-path">Vault Path</Label>
                <Input
                  id="vault-path"
                  placeholder={
                    vaultKvVersion === "1"
                      ? "kv/teams/engineering"
                      : "kv/data/teams/engineering"
                  }
                  value={vaultPath}
                  onChange={(e) => {
                    setVaultPath(e.target.value);
                    setConnectivityResult(null);
                  }}
                  className="font-mono"
                />
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>
                    Archestra is configured to use{" "}
                    <strong>
                      {vaultKvVersion === "1"
                        ? "Key-Value Secrets Engine V1"
                        : "Key-Value Secrets Engine V2"}
                    </strong>
                    .
                  </p>
                  {vaultKvVersion === "1" ? (
                    <>
                      <p>
                        It provides access to secrets on{" "}
                        <code className="bg-muted px-1 rounded">
                          {"<mount>/<path>"}
                        </code>
                        .
                      </p>
                      <p>
                        For example, if your secret engine is named{" "}
                        <code className="bg-muted px-1 rounded">secret_v1</code>{" "}
                        and path to folder is{" "}
                        <code className="bg-muted px-1 rounded">
                          platform/archestra
                        </code>
                        , then path will be{" "}
                        <code className="bg-muted px-1 rounded">
                          secret_v1/platform/archestra
                        </code>
                        .
                      </p>
                    </>
                  ) : (
                    <>
                      <p>
                        It provides access to secrets on{" "}
                        <code className="bg-muted px-1 rounded">
                          {"<mount>"}/<strong>data</strong>/{"<path>"}
                        </code>
                        .
                      </p>
                      <p>
                        For example, if your secret engine is named{" "}
                        <code className="bg-muted px-1 rounded">secret_v2</code>{" "}
                        and path to folder is{" "}
                        <code className="bg-muted px-1 rounded">
                          platform/archestra
                        </code>
                        , then path will be{" "}
                        <code className="bg-muted px-1 rounded">
                          secret_v2/<strong>data</strong>/platform/archestra
                        </code>
                        .
                      </p>
                    </>
                  )}
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <Button
                  onClick={handleSave}
                  disabled={
                    !vaultPath.trim() ||
                    !hasChanges ||
                    setFolderMutation.isPending
                  }
                >
                  {setFolderMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : hasExistingFolder ? (
                    "Update Path"
                  ) : (
                    "Save Path"
                  )}
                </Button>

                {vaultPath.trim() && (
                  <Button
                    variant="outline"
                    onClick={handleCheckConnectivity}
                    disabled={checkConnectivityMutation.isPending}
                  >
                    {checkConnectivityMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Testing...
                      </>
                    ) : (
                      "Test Connection"
                    )}
                  </Button>
                )}

                {hasExistingFolder && (
                  <Button
                    variant="outline"
                    onClick={handleDelete}
                    disabled={deleteFolderMutation.isPending}
                  >
                    <Trash2 className="mr-2 h-4 w-4 text-destructive" />
                    Remove
                  </Button>
                )}
              </div>

              {/* Connectivity result */}
              {connectivityResult && (
                <Alert
                  variant={
                    connectivityResult.connected ? "default" : "destructive"
                  }
                >
                  {connectivityResult.connected ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertTitle>
                    {connectivityResult.connected
                      ? "Connection Successful"
                      : "Connection Failed"}
                  </AlertTitle>
                  <AlertDescription>
                    {connectivityResult.connected
                      ? `Found ${connectivityResult.secretCount} secret${connectivityResult.secretCount !== 1 ? "s" : ""} in this folder.`
                      : connectivityResult.error ||
                        "Unable to connect to Vault"}
                  </AlertDescription>
                </Alert>
              )}

              {/* How it works */}
              <Alert>
                <Vault className="h-4 w-4" />
                <AlertTitle>How Team Vault Folders Work</AlertTitle>
                <AlertDescription className="space-y-2 text-sm">
                  <p>
                    Team Vault folders let you bring your own secrets from your
                    organization's HashiCorp Vault:
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li>
                      <strong>Browse secrets:</strong> Team admins can see
                      available secrets in the configured Vault folder
                    </li>
                    <li>
                      <strong>Install with Vault secrets:</strong> Select a
                      secret from Vault when installing an MCP server
                    </li>
                    <li>
                      <strong>Access control:</strong> Only team admins can
                      configure and use team Vault secrets
                    </li>
                  </ul>
                  <p className="text-muted-foreground">
                    Ensure Archestra has read access to the specified Vault
                    path.
                  </p>
                </AlertDescription>
              </Alert>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
