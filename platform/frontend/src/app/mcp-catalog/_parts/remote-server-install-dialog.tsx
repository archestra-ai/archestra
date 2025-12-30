"use client";

import type { archestraApiTypes } from "@shared";
import { Info, ShieldCheck, User } from "lucide-react";
import { lazy, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFeatureFlag } from "@/lib/features.hook";
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
}

export function RemoteServerInstallDialog({
  isOpen,
  onClose,
  onConfirm,
  catalogItem,
  isInstalling,
}: RemoteServerInstallDialogProps) {
  const [configValues, setConfigValues] = useState<Record<string, string>>({});

  // Team selection state
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [credentialType, setCredentialType] = useState<"personal" | "team">(
    "personal",
  );

  // BYOS (Bring Your Own Secrets) state - per-field vault references
  const [vaultSecrets, setVaultSecrets] = useState<
    Record<string, { path: string | null; key: string | null }>
  >({});

  const byosEnabled = useFeatureFlag("byosEnabled");

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

  // Show vault selector only for team installations when BYOS is enabled
  const useVaultSecrets = credentialType === "team" && byosEnabled;

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
    setCredentialType(byosEnabled ? "team" : "personal");
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
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <div className="flex items-end gap-2">
              <User className="h-5 w-5" />
              <span>
                Install Server
                <span className="text-muted-foreground ml-2 font-normal">
                  {catalogItem.name}
                </span>
              </span>
            </div>
            {hasOAuth && (
              <Badge variant="secondary" className="flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" />
                OAuth
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-6 py-4">
          <SelectMcpServerCredentialTypeAndTeams
            selectedTeamId={selectedTeamId}
            onTeamChange={setSelectedTeamId}
            catalogId={catalogItem?.id}
            onCredentialTypeChange={setCredentialType}
          />

          {hasOAuth && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                This server requires OAuth authentication. You'll be redirected
                to complete the authentication flow after clicking Install.
              </AlertDescription>
            </Alert>
          )}

          {/* Config fields - always show when config exists */}
          {hasConfig && (
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
                      {fieldConfig.description}
                    </p>
                  )}

                  {/* BYOS mode: vault selector for sensitive fields */}
                  {fieldConfig.type ===
                  "boolean" ? null : fieldConfig.sensitive &&
                    useVaultSecrets ? (
                    <InlineVaultSecretSelector
                      teamId={selectedTeamId}
                      selectedSecretPath={vaultSecrets[fieldName]?.path ?? null}
                      selectedSecretKey={vaultSecrets[fieldName]?.key ?? null}
                      onSecretPathChange={(path) =>
                        updateVaultSecret(fieldName, "path", path)
                      }
                      onSecretKeyChange={(key) =>
                        updateVaultSecret(fieldName, "key", key)
                      }
                      disabled={isInstalling}
                    />
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
                        fieldConfig.default?.toString() ||
                        fieldConfig.description
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

          {catalogItem.serverUrl && (
            <div className="rounded-md bg-muted p-4">
              <h4 className="text-sm font-medium mb-2">Server Details:</h4>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium">URL:</span>{" "}
                  {catalogItem.serverUrl}
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
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isInstalling}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!isValid || isInstalling}>
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
