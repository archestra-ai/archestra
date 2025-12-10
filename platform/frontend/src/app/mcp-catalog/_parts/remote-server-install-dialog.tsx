"use client";

import type { archestraApiTypes } from "@shared";
import { Info, ShieldCheck, User } from "lucide-react";
import { useState } from "react";
import { ExternalSecretSelector } from "@/components/external-secret-selector";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  /** External Vault secret path for BYOS */
  externalVaultSecret?: string;
  /** Team ID to assign the MCP server to (null for personal) */
  teamId?: string | null;
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

  // BYOS (Bring Your Own Secrets) state
  const [vaultTeamId, setVaultTeamId] = useState<string | null>(null);
  const [vaultSecretPath, setVaultSecretPath] = useState<string | null>(null);

  const byosEnabled = useFeatureFlag("byosEnabled");

  const handleConfirm = async () => {
    if (!catalogItem) {
      return;
    }

    const userConfig =
      (catalogItem.userConfig as UserConfigType | null | undefined) || {};

    // If vault secret is selected, use that instead of manual values
    if (vaultSecretPath) {
      try {
        await onConfirm(catalogItem, {
          metadata: {},
          externalVaultSecret: vaultSecretPath,
          teamId: selectedTeamId,
        });
        resetForm();
        onClose();
      } catch (_error) {
        // Error handling is done in the parent component
      }
      return;
    }

    // Validate required fields only when not using vault secret
    const requiredFields = Object.entries(userConfig).filter(
      ([_, config]) => config.required,
    );

    for (const [fieldName, _] of requiredFields) {
      if (!configValues[fieldName]?.trim()) {
        return;
      }
    }

    try {
      // Convert values to appropriate types based on config
      const metadata: Record<string, unknown> = {};
      for (const [fieldName, value] of Object.entries(configValues)) {
        const configField = userConfig[fieldName];
        if (!configField) continue;

        switch (configField.type) {
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

      await onConfirm(catalogItem, {
        metadata,
        teamId: selectedTeamId,
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
    setVaultTeamId(null);
    setVaultSecretPath(null);
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

  // Check if BYOS feature is available (enterprise license + Vault configured)
  const showByosOption = byosEnabled && hasConfig;

  // Check if config is valid:
  // - BYOS mode: vault must be selected
  // - Non-BYOS mode: manual values must be filled
  const isValid = showByosOption
    ? !!vaultSecretPath
    : !hasConfig ||
      Object.entries(userConfig)
        .filter(([_, cfg]) => cfg.required)
        .every(([fieldName]) => configValues[fieldName]?.trim());

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

          {/* Config fields - either BYOS vault selector or manual entry */}
          {hasConfig ? (
            showByosOption ? (
              <ExternalSecretSelector
                selectedTeamId={vaultTeamId}
                selectedSecretPath={vaultSecretPath}
                onTeamChange={setVaultTeamId}
                onSecretChange={setVaultSecretPath}
                disabled={isInstalling}
                expectedKeyHint="access_token"
              />
            ) : (
              <div className="space-y-4">
                {Object.entries(userConfig).map(([fieldName, fieldConfig]) => (
                  <div key={fieldName} className="grid gap-2">
                    <Label htmlFor={fieldName}>
                      {fieldConfig.title}
                      {fieldConfig.required && (
                        <span className="text-red-500"> *</span>
                      )}
                    </Label>
                    {fieldConfig.type === "boolean" ? (
                      <select
                        id={fieldName}
                        value={configValues[fieldName] || "false"}
                        onChange={(e) =>
                          setConfigValues((prev) => ({
                            ...prev,
                            [fieldName]: e.target.value,
                          }))
                        }
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                      >
                        <option value="false">No</option>
                        <option value="true">Yes</option>
                      </select>
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
            )
          ) : !hasOAuth ? (
            <div className="rounded-md bg-muted p-4">
              <p className="text-sm text-muted-foreground">
                This remote MCP server is ready to install. No additional
                configuration is required.
              </p>
            </div>
          ) : null}

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
