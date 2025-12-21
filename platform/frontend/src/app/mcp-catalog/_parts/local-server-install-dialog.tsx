"use client";

import type { archestraApiTypes } from "@shared";
import { lazy, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
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

const InlineVaultSecretSelector = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("@/components/inline-vault-secret-selector.ee"),
);

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

// Shared markdown components for consistent styling
const markdownComponents: Components = {
  p: (props) => (
    <p className="text-muted-foreground leading-relaxed text-xs" {...props} />
  ),
  strong: (props) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
  code: (props) => (
    <code
      className="bg-muted text-foreground px-1 py-0.5 rounded text-xs font-mono"
      {...props}
    />
  ),
  a: (props) => (
    <a
      className="text-primary hover:underline"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
};

export interface LocalServerInstallResult {
  environmentValues: Record<string, string>;
  /** Team ID to assign the MCP server to (null for personal) */
  teamId?: string | null;
  /** Whether environmentValues contains BYOS vault references in path#key format */
  isByosVault?: boolean;
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
  >(() =>
    promptedEnvVars.reduce<Record<string, string>>((acc, env) => {
      const defaultValue = env.default !== undefined ? String(env.default) : "";
      acc[env.key] = env.value || defaultValue;
      return acc;
    }, {}),
  );

  // BYOS (Bring Your Own Secrets) state - per-field vault references
  const [vaultSecrets, setVaultSecrets] = useState<
    Record<string, { path: string | null; key: string | null }>
  >({});

  const byosEnabled = useFeatureFlag("byosEnabled");

  // Show vault selector only for team installations when BYOS is enabled
  const useVaultSecrets = credentialType === "team" && byosEnabled;

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

  const handleEnvVarChange = (key: string, value: string) => {
    setEnvironmentValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleInstall = async () => {
    if (!catalogItem) return;

    const finalEnvironmentValues: Record<string, string> = {};

    // Add non-secret env var values (always from form)
    for (const env of nonSecretEnvVars) {
      if (environmentValues[env.key]) {
        finalEnvironmentValues[env.key] = environmentValues[env.key];
      }
    }

    // Add secret env var values
    for (const env of secretEnvVars) {
      if (useVaultSecrets) {
        // BYOS mode: use vault reference in path#key format
        const vaultRef = vaultSecrets[env.key];
        if (vaultRef?.path && vaultRef?.key) {
          finalEnvironmentValues[env.key] = `${vaultRef.path}#${vaultRef.key}`;
        }
      } else {
        // Non-BYOS mode: use manual value
        if (environmentValues[env.key]) {
          finalEnvironmentValues[env.key] = environmentValues[env.key];
        }
      }
    }

    await onConfirm({
      environmentValues: finalEnvironmentValues,
      teamId: selectedTeamId,
      isByosVault: useVaultSecrets && secretEnvVars.length > 0,
    });

    // Reset form
    resetForm();
  };

  const resetForm = () => {
    setEnvironmentValues(
      promptedEnvVars.reduce<Record<string, string>>((acc, env) => {
        acc[env.key] = env.value || String(env.default ?? "");
        return acc;
      }, {}),
    );
    setSelectedTeamId(null);
    setCredentialType(byosEnabled ? "team" : "personal");
    setVaultSecrets({});
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
  // - Vault mode (team + BYOS): each required secret field must have vault path AND key selected
  // - Manual mode (personal or BYOS disabled): manual secret values must be filled
  const isSecretsValid =
    secretEnvVars.length === 0 ||
    (useVaultSecrets
      ? secretEnvVars.every((env) => {
          if (!env.required) return true;
          const vaultRef = vaultSecrets[env.key];
          return vaultRef?.path && vaultRef?.key;
        })
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
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground prose prose-sm max-w-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={markdownComponents}
              >
                {catalogItem?.instructions ||
                  "Provide the required configuration values to install this MCP server."}
              </ReactMarkdown>
            </div>
          </DialogDescription>
        </DialogHeader>

        <SelectMcpServerCredentialTypeAndTeams
          selectedTeamId={selectedTeamId}
          onTeamChange={setSelectedTeamId}
          catalogId={catalogItem?.id}
          onCredentialTypeChange={setCredentialType}
        />

        <div className="space-y-6 mt-4">
          {/* Non-secret Environment Variables (always editable) */}
          {nonSecretEnvVars.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium">Configuration</h3>
              {nonSecretEnvVars.map((env) => (
                <div key={env.key} className="space-y-2">
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
                      <Label
                        htmlFor={`env-${env.key}`}
                        className="cursor-pointer"
                      >
                        {env.key}
                        {env.required && (
                          <span className="text-destructive ml-1">*</span>
                        )}
                      </Label>
                    </div>
                  ) : (
                    <Label htmlFor={`env-${env.key}`}>
                      {env.key}
                      {env.required && (
                        <span className="text-destructive ml-1">*</span>
                      )}
                    </Label>
                  )}
                  {env.description && (
                    <div className="text-xs text-muted-foreground prose prose-sm max-w-none">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        components={markdownComponents}
                      >
                        {env.description}
                      </ReactMarkdown>
                    </div>
                  )}

                  {env.type === "boolean" ? null : env.type === "number" ? (
                    <Input
                      id={`env-${env.key}`}
                      type="number"
                      value={environmentValues[env.key] || ""}
                      onChange={(e) =>
                        handleEnvVarChange(env.key, e.target.value)
                      }
                      placeholder={
                        env.default !== undefined ? String(env.default) : "0"
                      }
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

                {secretEnvVars.map((env) => (
                  <div key={env.key} className="space-y-2 mb-4">
                    <Label htmlFor={`env-${env.key}`}>
                      {env.key}
                      {env.required && (
                        <span className="text-destructive ml-1">*</span>
                      )}
                    </Label>
                    {env.description && (
                      <div className="text-xs text-muted-foreground prose prose-sm max-w-none">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkBreaks]}
                          components={markdownComponents}
                        >
                          {env.description}
                        </ReactMarkdown>
                      </div>
                    )}

                    {/* BYOS mode: vault selector for each secret field */}
                    {useVaultSecrets ? (
                      <InlineVaultSecretSelector
                        teamId={selectedTeamId}
                        selectedSecretPath={vaultSecrets[env.key]?.path ?? null}
                        selectedSecretKey={vaultSecrets[env.key]?.key ?? null}
                        onSecretPathChange={(path) =>
                          updateVaultSecret(env.key, "path", path)
                        }
                        onSecretKeyChange={(key) =>
                          updateVaultSecret(env.key, "key", key)
                        }
                        disabled={isInstalling}
                      />
                    ) : (
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
                    )}
                  </div>
                ))}
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
