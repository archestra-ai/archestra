"use client";

import { E2eTestId } from "@shared";
import { AlertCircle, Key, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeatureFlag } from "@/lib/features.hook";
import { useTeamsWithVaultFolders } from "@/lib/team.query";
import {
  useTeamVaultFolder,
  useTeamVaultFolderSecrets,
  useTeamVaultSecretKeys,
  type VaultSecretListItem,
} from "@/lib/team-vault-folder.query.ee";
import { CurrentVaultSecret } from "./current-vault-secret.ee";

interface ExternalSecretSelectorProps {
  selectedTeamId: string | null;
  selectedSecretPath: string | null;
  selectedSecretKey: string | null;
  onTeamChange: (teamId: string | null) => void;
  onSecretChange: (secretPath: string | null) => void;
  onSecretKeyChange: (key: string | null) => void;
  disabled?: boolean;
}

export default function ExternalSecretSelector({
  selectedTeamId,
  selectedSecretPath,
  selectedSecretKey,
  onTeamChange,
  onSecretChange,
  onSecretKeyChange,
  disabled = false,
}: ExternalSecretSelectorProps) {
  const byosEnabled = useFeatureFlag("byosEnabled");
  const { data: teamsWithVaultPaths, isLoading: isLoadingTeams } =
    useTeamsWithVaultFolders();
  const {
    data: vaultFolder,
    isLoading: isLoadingVaultFolder,
    error: vaultFolderError,
  } = useTeamVaultFolder(selectedTeamId);
  const {
    data: secrets,
    isLoading: isLoadingSecrets,
    error: secretsError,
  } = useTeamVaultFolderSecrets(
    selectedTeamId && vaultFolder?.vaultPath ? selectedTeamId : null,
  );
  const {
    data: secretKeysData,
    isLoading: isLoadingKeys,
    error: keysError,
  } = useTeamVaultSecretKeys(selectedTeamId, selectedSecretPath);

  // Don't show the selector if BYOS is not enabled
  if (!byosEnabled) {
    return null;
  }

  const teams = teamsWithVaultPaths || [];
  const availableKeys = secretKeysData?.keys || [];

  const handleTeamChange = (value: string) => {
    if (value === "none") {
      onTeamChange(null);
      onSecretChange(null);
      onSecretKeyChange(null);
    } else {
      onTeamChange(value);
      onSecretChange(null);
      onSecretKeyChange(null);
    }
  };

  const handleSecretChange = (value: string) => {
    if (value === "none") {
      onSecretChange(null);
      onSecretKeyChange(null);
    } else {
      onSecretChange(value);
      onSecretKeyChange(null);
    }
  };

  const handleKeyChange = (value: string) => {
    if (value === "none") {
      onSecretKeyChange(null);
    } else {
      onSecretKeyChange(value);
    }
  };

  return (
    <div
      className="space-y-4 rounded-lg border p-4 bg-muted/30"
      data-testid={E2eTestId.ExternalSecretSelector}
    >
      <p className="font-medium">Select external secret from Vault</p>
      {/* Team selector */}
      <div className="space-y-2">
        <Label htmlFor="vault-team">Team</Label>
        <p className="text-xs text-muted-foreground">
          Only teams where you are an admin and have a Vault folder configured
          are shown.
        </p>
        <Select
          value={selectedTeamId || "none"}
          onValueChange={handleTeamChange}
          disabled={disabled || isLoadingTeams}
        >
          <SelectTrigger
            id="vault-team"
            className="w-64"
            data-testid={E2eTestId.ExternalSecretSelectorTeamTrigger}
          >
            <SelectValue placeholder="Select a team..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">-- Select a team --</SelectItem>
            <TooltipProvider delayDuration={300}>
              {teams.map((team) => (
                <Tooltip key={team.id}>
                  <TooltipTrigger asChild>
                    <SelectItem value={team.id}>{team.name}</SelectItem>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-xs">
                    {team.vaultPath ? (
                      <span className="font-mono text-xs">
                        {team.vaultPath}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        No Vault folder configured
                      </span>
                    )}
                  </TooltipContent>
                </Tooltip>
              ))}
            </TooltipProvider>
          </SelectContent>
        </Select>
      </div>

      {/* Vault folder error */}
      {selectedTeamId && vaultFolderError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load Vault folder: {vaultFolderError.message}
          </AlertDescription>
        </Alert>
      )}

      {/* Vault folder status */}
      {selectedTeamId &&
        !isLoadingVaultFolder &&
        !vaultFolderError &&
        !vaultFolder?.vaultPath && (
          <Alert variant="default">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              This team doesn't have a Vault folder configured. A team admin can
              configure it in team settings.
            </AlertDescription>
          </Alert>
        )}

      {/* Secret selector */}
      {selectedTeamId && vaultFolder?.vaultPath && (
        <div className="space-y-2">
          <Label htmlFor="vault-secret">Secret</Label>
          {secretsError ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Failed to list secrets: {secretsError.message}
              </AlertDescription>
            </Alert>
          ) : isLoadingSecrets ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading secrets...
            </div>
          ) : secrets && secrets.length > 0 ? (
            <Select
              value={selectedSecretPath || "none"}
              onValueChange={handleSecretChange}
              disabled={disabled}
            >
              <SelectTrigger
                id="vault-secret"
                className="w-64"
                data-testid={E2eTestId.ExternalSecretSelectorSecretTrigger}
              >
                <SelectValue placeholder="Select a secret..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">-- Select a secret --</SelectItem>
                {secrets.map((secret: VaultSecretListItem) => (
                  <SelectItem key={secret.path} value={secret.path}>
                    <div className="flex items-center gap-2">
                      <Key className="h-3 w-3" />
                      {secret.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : Array.isArray(secrets) ? (
            <Alert variant="default">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                No secrets found in the configured Vault folder.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      )}

      {/* Key selector - always shown when secret is selected */}
      {selectedSecretPath && (
        <div className="space-y-2">
          <Label htmlFor="vault-key">Secret Key</Label>
          {keysError ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Failed to load secret keys:{" "}
                {keysError.message || "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : isLoadingKeys ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading keys...
            </div>
          ) : availableKeys.length > 0 ? (
            <>
              <Select
                value={selectedSecretKey || "none"}
                onValueChange={handleKeyChange}
                disabled={disabled}
              >
                <SelectTrigger
                  id="vault-key"
                  className="w-64"
                  data-testid={E2eTestId.ExternalSecretSelectorSecretTriggerKey}
                >
                  <SelectValue placeholder="Select a key..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">-- Select a key --</SelectItem>
                  {availableKeys.map((key) => (
                    <SelectItem key={key} value={key}>
                      <div className="flex items-center gap-2">
                        <Key className="h-3 w-3" />
                        {key}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Show saved vault reference when editing without team selected */}
              <div className="mt-4">
                <CurrentVaultSecret
                  selectedSecretPath={selectedSecretPath}
                  selectedSecretKey={selectedSecretKey}
                />
              </div>
            </>
          ) : (
            <Alert variant="default">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>No keys found in this secret.</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}
