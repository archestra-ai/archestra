"use client";

import type { archestraApiTypes } from "@shared";
import { AlertTriangle, Info, ShieldCheck, User } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LinkifiedText } from "@/components/ui/linkified-text";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFeature } from "@/lib/config.query";
import { useTeamsWithVaultFolders } from "@/lib/team.query";
import { SelectMcpServerCredentialTypeAndTeams } from "./select-mcp-server-credential-type-and-teams";

const InlineVaultSecretSelector = lazy(
  // biome-ignore lint/style/noRestrictedImports: lazy loading
  () => import("@/components/inline-vault-secret-selector.ee"),
);

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

type UserConfigType = Record<
  string,
  {
    type: "string" | "number" | "boolean" | "directory" | "file";
    title: string;
    description: string;
    required?: boolean;
    default?: string | number | boolean | Array<string>;
    multiple?: boolean;
    sensitive?: boolean;
    min?: number;
    max?: number;
  }
>;

export interface RemoteServerInstallResult {
  metadata: Record<string, unknown>;
  /** Team ID to assign the MCP server to (null for personal) */
  teamId?: string | null;
  /** Whether metadata contains BYOS vault references in path#key format */
  isByosVault?: boolean;
}

interface RemoteServerInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (
    catalogItem: CatalogItem,
    result: RemoteServerInstallResult,
  ) => Promise<void>;
  catalogItem: CatalogItem | null;
  isInstalling: boolean;
  /** When true, shows re-authentication mode (info banner, different title) */
  isReauth?: boolean;
  /** Pre-select a specific team in the credential type selector */
  preselectedTeamId?: string | null;
  /** When true, only personal installation is allowed */
  personalOnly?: boolean;
}

export function RemoteServerInstallDialog({
  isOpen,
  onClose,
  onConfirm,
  catalogItem,
  isInstalling,
  isReauth = false,
  preselectedTeamId,
  personalOnly = false,
}: RemoteServerInstallDialogProps) {
  const [configValues, setConfigValues] = useState<Record<string, string>>({});

  // Team selection state
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [credentialType, setCredentialType] = useState<"personal" | "team">(
    "personal",
  );
  const [canInstall, setCanInstall] = useState(true);

  // Vault team selection (separate from install team for personal + BYOS)
  const [vaultTeamId, setVaultTeamId] = useState<string | null>(null);

  // BYOS (Bring Your Own Secrets) state - per-field vault references
  const [vaultSecrets, setVaultSecrets] = useState<
    Record<string, { path: string | null; key: string | null }>
  >({});

  const byosEnabled = useFeature("byosEnabled");
  const { data: teamsWithVault } = useTeamsWithVaultFolders();
  const vaultTeams = teamsWithVault?.filter((t) => t.vaultPath);

  // Helper to update vault secret for a specific field
  const updateVaultSecret = (
    fieldName: string,
    prop: "path" | "key",
    value: string | null,
  ) => {
    setVaultSecrets((prev) => ({
      ...prev,
      [fieldName]: {
        ...prev[fieldName],
        [prop]: value,
        // Reset key when path changes
        ...(prop === "path" ? { key: null } : {}),
      },
    }));
  };

  // Sync vaultTeamId from selectedTeamId when in team mode, reset when switching to personal
  useEffect(() => {
    if (credentialType === "team") {
      setVaultTeamId(selectedTeamId);
    } else {
      setVaultTeamId(null);
    }
    setVaultSecrets({});
  }, [credentialType, selectedTeamId]);

  const handleVaultTeamChange = (teamId: string) => {
    setVaultTeamId(teamId);
    setVaultSecrets({});
  };

  // Show vault selector when BYOS is enabled (for both personal and team installations)
  const useVaultSecrets = byosEnabled;

  const handleConfirm = async () => {
    if (!catalogItem) {
      return;
    }

    const userConfig =
      (catalogItem.userConfig as UserConfigType | null | undefined) || {};

    try {
      const metadata: Record<string, unknown> = {};

      for (const [fieldName, fieldConfig] of Object.entries(userConfig)) {
        // For BYOS mode, sensitive fields use vault references
        if (useVaultSecrets && fieldConfig.sensitive) {
          const vaultRef = vaultSecrets[fieldName];
          if (vaultRef?.path && vaultRef?.key) {
            // Store as path#key format for BYOS vault resolution
            metadata[fieldName] = `${vaultRef.path}#${vaultRef.key}`;
          }
        } else {
          // Non-sensitive fields or non-BYOS mode: use manual value
          const value = configValues[fieldName];
          if (value !== undefined && value !== "") {
            switch (fieldConfig.type) {
              case "number":
                metadata[fieldName] = Number(value);
                break;
              case "boolean":
                metadata[fieldName] = value === "true";
                break;
              default:
                metadata[fieldName] = value;
            }
          }
        }
      }

      await onConfirm(catalogItem, {
        metadata,
        teamId: selectedTeamId,
        isByosVault: useVaultSecrets,
      });
      resetForm();
      onClose();
    } catch (_error) {
      // Error handling is done in the parent component
    }
  };

  const resetForm = () => {
    setConfigValues({});
    setSelectedTeamId(null);
    setCredentialType("personal");
    setVaultTeamId(null);
    setVaultSecrets({});
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  if (!catalogItem) {
    return null;
  }

  const userConfig =
    (catalogItem.userConfig as UserConfigType | null | undefined) || {};
  const hasConfig = Object.keys(userConfig).length > 0;
  const hasOAuth = !!catalogItem.oauthConfig;

  // Get sensitive and non-sensitive required fields
  const sensitiveRequiredFields = Object.entries(userConfig).filter(
    ([_, cfg]) => cfg.required && cfg.sensitive,
  );
  const nonSensitiveRequiredFields = Object.entries(userConfig).filter(
    ([_, cfg]) => cfg.required && !cfg.sensitive,
  );

  // Check if non-sensitive required fields are valid (always need manual input)
  const isNonSensitiveValid = nonSensitiveRequiredFields.every(([fieldName]) =>
    configValues[fieldName]?.trim(),
  );

  // Check if sensitive required fields are valid:
  // - BYOS mode: vault path AND key must be selected for each
  // - Normal mode: manual values must be filled
  const isSensitiveValid = useVaultSecrets
    ? sensitiveRequiredFields.every(
        ([fieldName]) =>
          vaultSecrets[fieldName]?.path && vaultSecrets[fieldName]?.key,
      )
    : sensitiveRequiredFields.every(([fieldName]) =>
        configValues[fieldName]?.trim(),
      );

  const isValid = !hasConfig || (isNonSensitiveValid && isSensitiveValid);

  return (
    <StandardFormDialog
      open={isOpen}
      onOpenChange={handleClose}
      title={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-end gap-2">
            <User className="h-5 w-5" />
            <span>
              {isReauth ? "Re-authenticate" : "Install Server"}
              <span className="text-muted-foreground ml-2 font-normal">
                {catalogItem.name}
              </span>
            </span>
          </div>
          {hasOAuth ? (
            <Badge variant="secondary" className="flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" />
              OAuth
            </Badge>
          ) : null}
        </div>
      }
      size="medium"
      bodyClassName="grid gap-6"
      onSubmit={handleConfirm}
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
            <Button type="submit" disabled={!isValid || isInstalling}>
              {isInstalling
                ? isReauth
                  ? "Updating..."
                  : "Installing..."
                : isReauth
                  ? "Update Credentials"
                  : "Install"}
            </Button>
          </>
        ) : null
      }
    >
      {isReauth && (
        <Alert className="border-amber-500/50 bg-amber-500/10">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <AlertDescription>
            Your existing credentials are expired or invalid. Submitting new
            credentials here will replace them while preserving your tool
            assignments.
          </AlertDescription>
        </Alert>
      )}

      <SelectMcpServerCredentialTypeAndTeams
        onTeamChange={setSelectedTeamId}
        catalogId={catalogItem?.id}
        onCredentialTypeChange={setCredentialType}
        onCanInstallChange={setCanInstall}
        preselectedTeamId={preselectedTeamId}
        personalOnly={personalOnly}
      />

      {useVaultSecrets && credentialType === "personal" && (
        <div className="space-y-2">
          <Label>Pull Vault secrets from:</Label>
          <p className="text-xs text-muted-foreground">
            Only folders associated with your teams are shown.
          </p>
          <Select
            value={vaultTeamId ?? ""}
            onValueChange={handleVaultTeamChange}
          >
            <SelectTrigger>
              <SelectValue placeholder="-- Select Vault folder --" />
            </SelectTrigger>
            <SelectContent>
              {vaultTeams?.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.vaultPath}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {canInstall && hasOAuth && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            This server requires OAuth authentication. You'll be redirected to
            complete the authentication flow after clicking Install.
          </AlertDescription>
        </Alert>
      )}

      {/* Config fields - always show when config exists */}
      {canInstall && hasConfig && (
        <div className="space-y-4">
          {Object.entries(userConfig).map(([fieldName, fieldConfig]) => (
            <div key={fieldName} className="grid gap-2">
              {fieldConfig.type === "boolean" ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={fieldName}
                    checked={configValues[fieldName] === "true"}
                    onCheckedChange={(checked) =>
                      setConfigValues((prev) => ({
                        ...prev,
                        [fieldName]: checked ? "true" : "false",
                      }))
                    }
                  />
                  <Label htmlFor={fieldName} className="cursor-pointer">
                    {fieldConfig.title}
                    {fieldConfig.required && (
                      <span className="text-red-500"> *</span>
                    )}
                  </Label>
                </div>
              ) : (
                <Label htmlFor={fieldName}>
                  {fieldConfig.title}
                  {fieldConfig.required && (
                    <span className="text-red-500"> *</span>
                  )}
                </Label>
              )}
              {fieldConfig.description && (
                <p className="text-xs text-muted-foreground">
                  <LinkifiedText>{fieldConfig.description}</LinkifiedText>
                </p>
              )}

              {/* BYOS mode: vault selector for sensitive fields */}
              {fieldConfig.type === "boolean" ? null : fieldConfig.sensitive &&
                useVaultSecrets ? (
                <Suspense
                  fallback={
                    <div className="text-sm text-muted-foreground">
                      Loading...
                    </div>
                  }
                >
                  <InlineVaultSecretSelector
                    teamId={vaultTeamId}
                    selectedSecretPath={vaultSecrets[fieldName]?.path ?? null}
                    selectedSecretKey={vaultSecrets[fieldName]?.key ?? null}
                    onSecretPathChange={(path) =>
                      updateVaultSecret(fieldName, "path", path)
                    }
                    onSecretKeyChange={(key) =>
                      updateVaultSecret(fieldName, "key", key)
                    }
                    disabled={isInstalling}
                    noTeamMessage={
                      credentialType === "personal"
                        ? "Select a vault folder to pull secrets from"
                        : undefined
                    }
                  />
                </Suspense>
              ) : (
                <Input
                  id={fieldName}
                  type={
                    fieldConfig.sensitive
                      ? "password"
                      : fieldConfig.type === "number"
                        ? "number"
                        : "text"
                  }
                  placeholder={
                    fieldConfig.default?.toString() || fieldConfig.description
                  }
                  value={configValues[fieldName] || ""}
                  onChange={(e) =>
                    setConfigValues((prev) => ({
                      ...prev,
                      [fieldName]: e.target.value,
                    }))
                  }
                  min={fieldConfig.min}
                  max={fieldConfig.max}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {canInstall && catalogItem.serverUrl && (
        <div className="rounded-md bg-muted p-4">
          <h4 className="text-sm font-medium mb-2">Server Details:</h4>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium">URL:</span> {catalogItem.serverUrl}
            </p>
            {catalogItem.docsUrl && (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium">Documentation:</span>{" "}
                <a
                  href={catalogItem.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {catalogItem.docsUrl}
                </a>
              </p>
            )}
          </div>
        </div>
      )}
    </StandardFormDialog>
  );
}
