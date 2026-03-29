"use client";

import { type archestraApiTypes, isPlaywrightCatalogItem } from "@shared";
import { AlertTriangle } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useFeature } from "@/lib/config/config.query";
import { useTeamsWithVaultFolders } from "@/lib/teams/team.query";
import { SelectMcpServerCredentialTypeAndTeams } from "./select-mcp-server-credential-type-and-teams";
import { ServiceAccountField } from "./service-account-field";

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
  /** Kubernetes service account for the MCP server pod */
  serviceAccount?: string;
}

interface LocalServerInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (result: LocalServerInstallResult) => Promise<void>;
  catalogItem: CatalogItem | null;
  isInstalling: boolean;
  /** When true, shows "Reinstall" instead of "Install" in the dialog */
  isReinstall?: boolean;
  /** The team ID of the existing server being reinstalled (null = personal) */
  existingTeamId?: string | null;
  /** When true, shows re-authentication mode (info banner, different title) */
  isReauth?: boolean;
  /** Pre-select a specific team in the credential type selector */
  preselectedTeamId?: string | null;
  /** When true, only personal installation is allowed */
  personalOnly?: boolean;
}

export function LocalServerInstallDialog({
  isOpen,
  onClose,
  onConfirm,
  catalogItem,
  isInstalling,
  isReinstall = false,
  existingTeamId,
  isReauth = false,
  preselectedTeamId,
  personalOnly: personalOnlyProp = false,
}: LocalServerInstallDialogProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [credentialType, setCredentialType] = useState<"personal" | "team">(
    "personal",
  );
  const [canInstall, setCanInstall] = useState(true);
  const [serviceAccount, setServiceAccount] = useState<string | undefined>(
    catalogItem?.localConfig?.serviceAccount,
  );
  // Extract environment variables that need prompting during installation
  const promptedEnvVars =
    catalogItem?.localConfig?.environment?.filter(
      (env) => env.promptOnInstallation === true,
    ) || [];

  // Separate secret vs non-secret env vars
  // Secret env vars can be loaded from vault, non-secret must be entered manually
  // Note: 'mounted' field is added in schema but types may not be regenerated yet
  const secretEnvVars = promptedEnvVars.filter(
    (env) => env.type === "secret" && !(env as { mounted?: boolean }).mounted,
  );
  const secretFileVars = promptedEnvVars.filter(
    (env) =>
      env.type === "secret" && (env as { mounted?: boolean }).mounted === true,
  );
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

  // Vault team selection (separate from install team for personal + BYOS)
  const [vaultTeamId, setVaultTeamId] = useState<string | null>(null);

  // BYOS (Bring Your Own Secrets) state - per-field vault references
  const [vaultSecrets, setVaultSecrets] = useState<
    Record<string, { path: string | null; key: string | null }>
  >({});

  const byosEnabled = useFeature("byosEnabled");
  const { data: teamsWithVault } = useTeamsWithVaultFolders();
  const vaultTeams = teamsWithVault?.filter((t) => t.vaultPath);

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

    // Add secret file values
    for (const env of secretFileVars) {
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
      isByosVault:
        useVaultSecrets &&
        (secretEnvVars.length > 0 || secretFileVars.length > 0),
      serviceAccount: serviceAccount || undefined,
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
    setCredentialType("personal");
    setVaultTeamId(null);
    setVaultSecrets({});
    setServiceAccount(catalogItem?.localConfig?.serviceAccount);
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
  const allSecrets = [...secretEnvVars, ...secretFileVars];
  const isSecretsValid =
    allSecrets.length === 0 ||
    (useVaultSecrets
      ? allSecrets.every((env) => {
          if (!env.required) return true;
          const vaultRef = vaultSecrets[env.key];
          return vaultRef?.path && vaultRef?.key;
        })
      : allSecrets.every((env) => {
          if (!env.required) return true;
          const value = environmentValues[env.key];
          return !!value?.trim();
        }));

  const isValid = isNonSecretValid && isSecretsValid;

  return (
    <StandardFormDialog
      open={isOpen}
      onOpenChange={handleClose}
      title={
        <span>
          {isReauth ? "Re-authenticate" : isReinstall ? "Reinstall" : "Install"}{" "}
          - {catalogItem?.name}
        </span>
      }
      description={
        catalogItem?.instructions ? (
          <div className="prose prose-sm max-w-none text-sm text-muted-foreground">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks]}
              components={markdownComponents}
            >
              {catalogItem.instructions}
            </ReactMarkdown>
          </div>
        ) : undefined
      }
      size="medium"
      className="max-w-2xl max-h-[80vh]"
      bodyClassName="space-y-6 px-6"
      onSubmit={handleInstall}
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
                  : isReinstall
                    ? "Reinstalling..."
                    : "Installing..."
                : isReauth
                  ? "Update Credentials"
                  : isReinstall
                    ? "Reinstall"
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
        catalogId={isReinstall ? undefined : catalogItem?.id}
        onCredentialTypeChange={setCredentialType}
        onCanInstallChange={setCanInstall}
        isReinstall={isReinstall}
        existingTeamId={existingTeamId}
        personalOnly={
          personalOnlyProp ||
          (catalogItem ? isPlaywrightCatalogItem(catalogItem.id) : false)
        }
        preselectedTeamId={preselectedTeamId}
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

      {canInstall && catalogItem?.localConfig?.serviceAccount !== undefined && (
        <ServiceAccountField
          value={serviceAccount}
          onChange={setServiceAccount}
          disabled={isInstalling}
        />
      )}

      {canInstall && (
        <div className="space-y-6">
          {/* Non-secret Environment Variables (always editable) */}
          {nonSecretEnvVars.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium sr-only">Configuration</h3>
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

          {/* Secrets Section (env vars and files) */}
          {(secretEnvVars.length > 0 || secretFileVars.length > 0) && (
            <>
              {nonSecretEnvVars.length > 0 && <Separator />}

              <div className="space-y-4">
                <h3 className="text-sm font-medium">Secrets</h3>

                {/* Secret Environment Variables */}
                {secretEnvVars.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="text-sm font-medium text-muted-foreground">
                      Environment Variables
                    </h4>
                    {secretEnvVars.map((env) => (
                      <div key={env.key} className="space-y-2">
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
                          <Suspense
                            fallback={
                              <div className="text-sm text-muted-foreground">
                                Loading...
                              </div>
                            }
                          >
                            <InlineVaultSecretSelector
                              teamId={vaultTeamId}
                              selectedSecretPath={
                                vaultSecrets[env.key]?.path ?? null
                              }
                              selectedSecretKey={
                                vaultSecrets[env.key]?.key ?? null
                              }
                              onSecretPathChange={(path) =>
                                updateVaultSecret(env.key, "path", path)
                              }
                              onSecretKeyChange={(key) =>
                                updateVaultSecret(env.key, "key", key)
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
                )}

                {/* Secret Files (mounted as files at /secrets/<key>) */}
                {secretFileVars.length > 0 && (
                  <div className="space-y-4">
                    {secretEnvVars.length > 0 && <Separator />}
                    <h4 className="text-sm font-medium text-muted-foreground">
                      Files
                    </h4>

                    {secretFileVars.map((env) => (
                      <div key={env.key} className="space-y-2">
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
                          <Suspense
                            fallback={
                              <div className="text-sm text-muted-foreground">
                                Loading...
                              </div>
                            }
                          >
                            <InlineVaultSecretSelector
                              teamId={vaultTeamId}
                              selectedSecretPath={
                                vaultSecrets[env.key]?.path ?? null
                              }
                              selectedSecretKey={
                                vaultSecrets[env.key]?.key ?? null
                              }
                              onSecretPathChange={(path) =>
                                updateVaultSecret(env.key, "path", path)
                              }
                              onSecretKeyChange={(key) =>
                                updateVaultSecret(env.key, "key", key)
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
                          <AutoResizeTextarea
                            id={`env-${env.key}`}
                            value={environmentValues[env.key] || ""}
                            onChange={(value) =>
                              handleEnvVarChange(env.key, value)
                            }
                            disabled={isInstalling}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </StandardFormDialog>
  );
}

const MAX_TEXTAREA_HEIGHT = 200;

function AutoResizeTextarea({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-adjust height when value changes
  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  return (
    <Textarea
      ref={textareaRef}
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="font-mono text-xs resize-none min-h-10 max-h-[200px] overflow-y-auto"
      rows={1}
      onInput={adjustHeight}
      disabled={disabled}
    />
  );
}
