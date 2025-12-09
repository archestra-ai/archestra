"use client";

import { AlertCircle, CheckCircle2, Key, Loader2 } from "lucide-react";
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
} from "@/lib/team-vault-folder.query";

interface ExternalSecretSelectorProps {
  selectedTeamId: string | null;
  selectedSecretPath: string | null;
  onTeamChange: (teamId: string | null) => void;
  onSecretChange: (secretPath: string | null) => void;
  disabled?: boolean;
  /** Expected key names hint to show to users (e.g., "API_KEY, SECRET_TOKEN") */
  expectedKeyHint?: string;
}

export function ExternalSecretSelector({
  selectedTeamId,
  selectedSecretPath,
  onTeamChange,
  onSecretChange,
  disabled = false,
  expectedKeyHint,
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

  // Parse expected keys and check which ones are present
  const expectedKeys = expectedKeyHint
    ? expectedKeyHint.split(",").map((k) => k.trim())
    : [];
  const actualKeys = secretKeysData?.keys || [];
  const missingKeys = expectedKeys.filter((key) => !actualKeys.includes(key));
  const allKeysPresent = expectedKeys.length > 0 && missingKeys.length === 0;

  const handleTeamChange = (value: string) => {
    if (value === "none") {
      onTeamChange(null);
      onSecretChange(null);
    } else {
      onTeamChange(value);
      onSecretChange(null);
    }
  };

  const handleSecretChange = (value: string) => {
    if (value === "none") {
      onSecretChange(null);
    } else {
      onSecretChange(value);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border p-4 bg-muted/30">
      <span className="font-medium">Select external secret from Vault</span>

      {/* Show expected keys hint at the top */}
      {expectedKeyHint && (
        <p className="text-xs text-muted-foreground">
          Archestra expects the following keys to exist in this secret:{" "}
          <code className="font-mono bg-muted px-1 rounded">
            {expectedKeyHint}
          </code>
        </p>
      )}

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
          <SelectTrigger id="vault-team" className="w-64">
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
              <SelectTrigger id="vault-secret" className="w-64">
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

          {/* Key validation feedback */}
          {selectedSecretPath &&
            expectedKeys.length > 0 &&
            (isLoadingKeys ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Validating secret keys...
              </div>
            ) : keysError ? (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Failed to validate secret keys:{" "}
                  {keysError.message || "Unknown error"}
                </AlertDescription>
              </Alert>
            ) : allKeysPresent ? (
              <div className="flex items-center gap-2 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                All expected keys found in the secret
              </div>
            ) : missingKeys.length > 0 ? (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Secret has missing keys:{" "}
                  <code className="font-mono bg-destructive/10 px-1 rounded">
                    {missingKeys.join(", ")}
                  </code>
                </AlertDescription>
              </Alert>
            ) : null)}
        </div>
      )}
    </div>
  );
}
