"use client";

import type { archestraApiTypes } from "@shared";
import { useState } from "react";
import { InlineVaultSecretSelector } from "@/components/inline-vault-secret-selector";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Separator } from "@/components/ui/separator";
import { useFeatureFlag } from "@/lib/features.hook";
import { SelectMcpServerCredentialTypeAndTeams } from "./select-mcp-server-credential-type-and-teams";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export interface LocalServerInstallResult {
  environmentValues: Record<string, string>;
  /** External Vault path to access token secret for BYOS */
  accessTokenExternalSecretPath?: string;
  /** External Vault secret key for access token (the key within the secret to use) */
  accessTokenExternalSecretKey?: string;
  /** Team ID to assign the MCP server to (null for personal) */
  teamId?: string | null;
}

interface LocalServerInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (result: LocalServerInstallResult) => Promise<void>;
  catalogItem: CatalogItem | null;
  isInstalling: boolean;
}

export function LocalServerInstallDialog({
  isOpen,
  onClose,
  onConfirm,
  catalogItem,
  isInstalling,
}: LocalServerInstallDialogProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [credentialType, setCredentialType] = useState<"personal" | "team">(
    "personal",
  );

  // Extract environment variables that need prompting during installation
  const promptedEnvVars =
    catalogItem?.localConfig?.environment?.filter(
      (env) => env.promptOnInstallation === true,
    ) || [];

  // Separate secret vs non-secret env vars
  // Secret env vars can be loaded from vault, non-secret must be entered manually
  const secretEnvVars = promptedEnvVars.filter((env) => env.type === "secret");
  const nonSecretEnvVars = promptedEnvVars.filter(
    (env) => env.type !== "secret",
  );

  const [environmentValues, setEnvironmentValues] = useState<
    Record<string, string>
  >(
    promptedEnvVars.reduce<Record<string, string>>((acc, env) => {
      acc[env.key] = env.value || "";
      return acc;
    }, {}),
  );

  // BYOS (Bring Your Own Secrets) state - vault uses the same teamId as MCP server
  const [selectedSecretPath, setSelectedSecretPath] = useState<string | null>(
    null,
  );
  const [selectedSecretKey, setSelectedSecretKey] = useState<string | null>(
    null,
  );

  const byosEnabled = useFeatureFlag("byosEnabled");

  // Show vault selector only for team installations when BYOS is enabled
  const useVaultSecrets = credentialType === "team" && byosEnabled;

  const handleEnvVarChange = (key: string, value: string) => {
    setEnvironmentValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleInstall = async () => {
    if (!catalogItem) return;

    // Vault mode (team + BYOS): secrets from vault, non-secrets from form
    if (
      useVaultSecrets &&
      secretEnvVars.length > 0 &&
      selectedSecretPath &&
      selectedSecretKey
    ) {
      // Include only non-secret env var values (secret ones come from vault)
      const nonSecretValues: Record<string, string> = {};
      for (const env of nonSecretEnvVars) {
        if (environmentValues[env.key]) {
          nonSecretValues[env.key] = environmentValues[env.key];
        }
      }

      await onConfirm({
        environmentValues: nonSecretValues,
        accessTokenExternalSecretPath: selectedSecretPath,
        accessTokenExternalSecretKey: selectedSecretKey,
        teamId: selectedTeamId,
      });
    } else {
      // Non-BYOS mode: all values from form
      await onConfirm({ environmentValues, teamId: selectedTeamId });
    }

    // Reset form
    resetForm();
  };

  const resetForm = () => {
    setEnvironmentValues(
      promptedEnvVars.reduce<Record<string, string>>((acc, env) => {
        acc[env.key] = env.value || "";
        return acc;
      }, {}),
    );
    setSelectedTeamId(null);
    setCredentialType("personal");
    setSelectedSecretPath(null);
    setSelectedSecretKey(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  // Check if non-secret env vars are valid (always required)
  const isNonSecretValid = nonSecretEnvVars.every((env) => {
    if (!env.required) return true;
    const value = environmentValues[env.key];
    if (env.type === "boolean") {
      return !!value;
    }
    return !!value?.trim();
  });

  // Check if secrets are valid:
  // - Vault mode (team + BYOS): vault path AND key must be selected
  // - Manual mode (personal or BYOS disabled): manual secret values must be filled
  const isSecretsValid =
    secretEnvVars.length === 0 ||
    (useVaultSecrets
      ? !!selectedSecretPath && !!selectedSecretKey
      : secretEnvVars.every((env) => {
          if (!env.required) return true;
          const value = environmentValues[env.key];
          return !!value?.trim();
        }));

  const isValid = isNonSecretValid && isSecretsValid;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Install - {catalogItem?.name}</DialogTitle>
          <DialogDescription>
            Provide the required configuration values to install this MCP
            server.
          </DialogDescription>
        </DialogHeader>

        <SelectMcpServerCredentialTypeAndTeams
          selectedTeamId={selectedTeamId}
          onTeamChange={setSelectedTeamId}
          catalogId={catalogItem?.id}
          onCredentialTypeChange={setCredentialType}
          vaultSecretSelector={
            <InlineVaultSecretSelector
              teamId={selectedTeamId}
              selectedSecretPath={selectedSecretPath}
              selectedSecretKey={selectedSecretKey}
              onSecretPathChange={setSelectedSecretPath}
              onSecretKeyChange={setSelectedSecretKey}
              disabled={isInstalling}
            />
          }
        />

        <div className="space-y-6 mt-4">
          {/* Non-secret Environment Variables (always editable) */}
          {nonSecretEnvVars.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium">Configuration</h3>
              {nonSecretEnvVars.map((env) => (
                <div key={env.key} className="space-y-2">
                  <Label htmlFor={`env-${env.key}`}>
                    {env.key}
                    {env.required && (
                      <span className="text-destructive ml-1">*</span>
                    )}
                  </Label>
                  {env.description && (
                    <p className="text-xs text-muted-foreground">
                      {env.description}
                    </p>
                  )}

                  {env.type === "boolean" ? (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`env-${env.key}`}
                        checked={environmentValues[env.key] === "true"}
                        onCheckedChange={(checked) =>
                          handleEnvVarChange(
                            env.key,
                            checked ? "true" : "false",
                          )
                        }
                        disabled={isInstalling}
                      />
                      <span className="text-sm">
                        {environmentValues[env.key] === "true"
                          ? "True"
                          : "False"}
                      </span>
                    </div>
                  ) : env.type === "number" ? (
                    <Input
                      id={`env-${env.key}`}
                      type="number"
                      value={environmentValues[env.key] || ""}
                      onChange={(e) =>
                        handleEnvVarChange(env.key, e.target.value)
                      }
                      placeholder="0"
                      className="font-mono"
                      disabled={isInstalling}
                    />
                  ) : (
                    <Input
                      id={`env-${env.key}`}
                      type="text"
                      value={environmentValues[env.key] || ""}
                      onChange={(e) =>
                        handleEnvVarChange(env.key, e.target.value)
                      }
                      placeholder={`Enter value for ${env.key}`}
                      className="font-mono"
                      disabled={isInstalling}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Secret Environment Variables */}
          {secretEnvVars.length > 0 && (
            <>
              {nonSecretEnvVars.length > 0 && <Separator />}

              <div className="space-y-4">
                <h3 className="text-sm font-medium">Secrets</h3>

                {/* Vault mode (team + BYOS): vault selection */}
                {useVaultSecrets ? (
                  <div className="space-y-2">
                    <Label>Select External Secret</Label>
                    <InlineVaultSecretSelector
                      teamId={selectedTeamId}
                      selectedSecretPath={selectedSecretPath}
                      selectedSecretKey={selectedSecretKey}
                      onSecretPathChange={setSelectedSecretPath}
                      onSecretKeyChange={setSelectedSecretKey}
                      disabled={isInstalling}
                    />
                  </div>
                ) : (
                  /* Non-BYOS mode: Manual secret entry */
                  <>
                    <p className="text-sm text-muted-foreground mb-3">
                      Enter secret values
                    </p>
                    {secretEnvVars.map((env) => (
                      <div key={env.key} className="space-y-2 mb-4">
                        <Label htmlFor={`env-${env.key}`}>
                          {env.key}
                          {env.required && (
                            <span className="text-destructive ml-1">*</span>
                          )}
                        </Label>
                        {env.description && (
                          <p className="text-xs text-muted-foreground">
                            {env.description}
                          </p>
                        )}
                        <Input
                          id={`env-${env.key}`}
                          type="password"
                          value={environmentValues[env.key] || ""}
                          onChange={(e) =>
                            handleEnvVarChange(env.key, e.target.value)
                          }
                          placeholder={`Enter value for ${env.key}`}
                          className="font-mono"
                          disabled={isInstalling}
                        />
                      </div>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isInstalling}
          >
            Cancel
          </Button>
          <Button onClick={handleInstall} disabled={!isValid || isInstalling}>
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
