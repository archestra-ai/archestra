"use client";

import { AlertCircle, Key, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useTeamVaultFolderSecrets,
  useTeamVaultSecretKeys,
  type VaultSecretListItem,
} from "@/lib/team-vault-folder.query.ee";
import { E2eTestId } from "../../../shared";

interface InlineVaultSecretSelectorProps {
  /** The team ID whose vault folder to use */
  teamId: string | null;
  /** Currently selected secret path */
  selectedSecretPath: string | null;
  /** Currently selected key within the secret */
  selectedSecretKey: string | null;
  /** Callback when secret path changes */
  onSecretPathChange: (path: string | null) => void;
  /** Callback when secret key changes */
  onSecretKeyChange: (key: string | null) => void;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Placeholder text for the secret dropdown */
  secretPlaceholder?: string;
  /** Placeholder text for the key dropdown */
  keyPlaceholder?: string;
}

/**
 * Inline vault secret selector - a compact component that replaces password inputs
 * when BYOS is enabled. Shows two dropdowns: one for selecting a secret from the
 * team's vault folder, and one for selecting a key within that secret.
 *
 * This component expects a teamId to be provided - the team selection should be
 * handled by a parent component (shared across all secret selectors).
 */
export default function InlineVaultSecretSelector({
  teamId,
  selectedSecretPath,
  selectedSecretKey,
  onSecretPathChange,
  onSecretKeyChange,
  disabled = false,
  secretPlaceholder = "Select secret...",
  keyPlaceholder = "Select key...",
}: InlineVaultSecretSelectorProps) {
  const {
    data: secrets,
    isLoading: isLoadingSecrets,
    error: secretsError,
  } = useTeamVaultFolderSecrets(teamId);

  const {
    data: secretKeysData,
    isLoading: isLoadingKeys,
    error: keysError,
  } = useTeamVaultSecretKeys(teamId, selectedSecretPath);

  const availableKeys = secretKeysData?.keys || [];

  const handleSecretChange = (value: string) => {
    if (value === "none") {
      onSecretPathChange(null);
      onSecretKeyChange(null);
    } else {
      onSecretPathChange(value);
      onSecretKeyChange(null); // Reset key when secret changes
    }
  };

  const handleKeyChange = (value: string) => {
    if (value === "none") {
      onSecretKeyChange(null);
    } else {
      onSecretKeyChange(value);
    }
  };

  // If no team selected, show a message
  if (!teamId) {
    return (
      <div className="text-sm text-muted-foreground italic">
        Select a team above to choose a vault secret
      </div>
    );
  }

  // Loading secrets
  if (isLoadingSecrets) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading secrets...
      </div>
    );
  }

  // Error loading secrets
  if (secretsError) {
    return (
      <Alert variant="destructive" className="py-2">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription className="text-xs">
          Failed to load secrets: {secretsError.message}
        </AlertDescription>
      </Alert>
    );
  }

  // No secrets found
  if (!secrets || secrets.length === 0) {
    return (
      <Alert variant="default" className="py-2">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription className="text-xs">
          No secrets found in the team's Vault folder
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex gap-2 items-start">
      {/* Secret selector */}
      <Select
        value={selectedSecretPath || "none"}
        onValueChange={handleSecretChange}
        disabled={disabled}
      >
        <SelectTrigger
          className="w-48"
          data-testid={E2eTestId.InlineVaultSecretSelectorSecretTrigger}
        >
          <SelectValue placeholder={secretPlaceholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">-- {secretPlaceholder} --</SelectItem>
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

      {/* Key selector */}
      {selectedSecretPath &&
        (isLoadingKeys ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground h-10">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : keysError ? (
          <Alert variant="destructive" className="py-2 flex-1">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {keysError.message}
            </AlertDescription>
          </Alert>
        ) : availableKeys.length === 0 ? (
          <Alert variant="default" className="py-2 flex-1">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              No keys found
            </AlertDescription>
          </Alert>
        ) : (
          <Select
            value={selectedSecretKey || "none"}
            onValueChange={handleKeyChange}
            disabled={disabled}
          >
            <SelectTrigger
              className="w-48"
              data-testid={E2eTestId.InlineVaultSecretSelectorSecretTriggerKey}
            >
              <SelectValue placeholder={keyPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">-- {keyPlaceholder} --</SelectItem>
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
        ))}
    </div>
  );
}
