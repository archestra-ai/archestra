"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { AlertTriangle, Info, KeyRound, ShieldCheck, User } from "lucide-react";
import { useState } from "react";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LinkifiedText } from "@/components/ui/linkified-text";
import { SecretInput } from "@/components/ui/secret-input";
import { useEnvironments } from "@/lib/environment.query";
import { MCP_CONFIG_AUTOCOMPLETE } from "@/lib/mcp/mcp-form-autocomplete";
import { useDefaultEnvironment } from "@/lib/organization.query";
import {
  compileValidationRegex,
  toFieldValueType,
  validateFieldAgainstRegex,
} from "./environment-validation-helpers";
import { InlineCredentialFormShell } from "./inline-credential-form-shell";
import {
  type McpServerInstallScope,
  SelectMcpServerCredentialTypeAndTeams,
} from "./select-mcp-server-credential-type-and-teams";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

type UserConfigType = Record<
  string,
  {
    type: "string" | "number" | "boolean" | "directory" | "file";
    title: string;
    description: string;
    promptOnInstallation?: boolean;
    required?: boolean;
    default?: string | number | boolean | Array<string>;
    multiple?: boolean;
    sensitive?: boolean;
    min?: number;
    max?: number;
  }
>;

export interface RemoteServerInstallResult {
  /** Catalog id to install from. */
  catalogId: string;
  metadata: Record<string, unknown>;
  /** Installation scope (personal, team, org) */
  scope: McpServerInstallScope;
  /** Team ID to assign the MCP server to (only when scope is "team") */
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
  /** When true, shows re-authentication mode (info banner, different title) */
  isReauth?: boolean;
  /**
   * Reinstall mode — same form layout as reauth but submits to the reinstall
   * route. Used when a catalog edit added new required userConfig fields and
   * the existing install needs values for them.
   */
  isReinstall?: boolean;
  /** Scope of the install being reinstalled (locks the scope picker). */
  existingScope?: McpServerInstallScope;
  /** Team of the install being reinstalled (null for personal/org). */
  existingTeamId?: string | null;
  /** Pre-select a specific team in the credential type selector */
  preselectedTeamId?: string | null;
  /** When true, only personal installation is allowed */
  personalOnly?: boolean;
  /** When true, only organization-wide installation is allowed */
  orgOnly?: boolean;
  presentation?: "dialog" | "inline";
}

export function RemoteServerInstallDialog({
  isOpen,
  onClose,
  onConfirm,
  catalogItem,
  isInstalling,
  isReauth = false,
  isReinstall = false,
  existingScope,
  existingTeamId,
  preselectedTeamId,
  personalOnly = false,
  orgOnly = false,
  presentation = "dialog",
}: RemoteServerInstallDialogProps) {
  const [configValues, setConfigValues] = useState<Record<string, string>>({});

  // Team selection state
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [scope, setScope] = useState<McpServerInstallScope>(
    orgOnly ? "org" : "personal",
  );
  const [canInstall, setCanInstall] = useState(true);

  const { data: environmentList } = useEnvironments();
  const defaultEnvironment = useDefaultEnvironment();
  const userConfig =
    (catalogItem?.userConfig as UserConfigType | null | undefined) || {};

  // Sync vaultTeamId from selectedTeamId when in team mode, reset otherwise

  const handleConfirm = async () => {
    if (!catalogItem) {
      return;
    }

    try {
      const metadata: Record<string, unknown> = {};

      for (const [fieldName, fieldConfig] of Object.entries(userConfig)) {
        if (fieldConfig.promptOnInstallation === false) {
          continue;
        }

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

      await onConfirm(catalogItem, {
        catalogId: catalogItem.id,
        metadata,
        scope,
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
    setScope(orgOnly ? "org" : "personal");
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  if (!catalogItem) {
    return null;
  }

  const promptableUserConfig = Object.fromEntries(
    Object.entries(userConfig).filter(([_fieldName, fieldConfig]) => {
      return fieldConfig.promptOnInstallation !== false;
    }),
  );
  const hasConfig = Object.keys(promptableUserConfig).length > 0;
  const hasOAuth = !!catalogItem.oauthConfig;
  const usesBrowserOAuth =
    catalogItem.oauthConfig?.grant_type !== "client_credentials";

  // Get sensitive and non-sensitive required fields
  const sensitiveRequiredFields = Object.entries(promptableUserConfig).filter(
    ([_, cfg]) => cfg.required && cfg.sensitive,
  );
  const nonSensitiveRequiredFields = Object.entries(
    promptableUserConfig,
  ).filter(([_, cfg]) => cfg.required && !cfg.sensitive);

  // Check if non-sensitive required fields are valid (always need manual input)
  const isNonSensitiveValid = nonSensitiveRequiredFields.every(([fieldName]) =>
    configValues[fieldName]?.trim(),
  );

  // Check if sensitive required fields are valid:
  // - Normal mode: manual values must be filled
  const isSensitiveValid = sensitiveRequiredFields.every(([fieldName]) =>
    configValues[fieldName]?.trim(),
  );

  const isValid = !hasConfig || (isNonSensitiveValid && isSensitiveValid);

  // Resolve the governing environment's allowlist regex (the env the catalog
  // item is bound to, or the org default when unbound) and compile it once.
  const boundEnvironment = catalogItem.environmentId
    ? environmentList?.environments.find(
        (e) => e.id === catalogItem.environmentId,
      )
    : null;
  const environmentName = boundEnvironment?.name ?? defaultEnvironment.name;
  const validationRegex = compileValidationRegex(
    boundEnvironment
      ? boundEnvironment.validationRegex
      : defaultEnvironment.validationRegex,
  );
  const configRegexError = (
    fieldName: string,
    type: string | undefined,
  ): string | null =>
    validateFieldAgainstRegex({
      value: configValues[fieldName] ?? "",
      regex: validationRegex,
      valueType: toFieldValueType(type),
      environmentName,
    });
  const hasRegexErrors = Object.entries(promptableUserConfig).some(
    ([fieldName, cfg]) =>
      !cfg.sensitive && configRegexError(fieldName, cfg.type) !== null,
  );
  const FormShell =
    presentation === "inline" ? InlineCredentialFormShell : StandardFormDialog;

  return (
    <FormShell
      open={isOpen}
      onOpenChange={handleClose}
      title={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-end gap-2">
            <User className="h-5 w-5" />
            <span>
              {isReauth
                ? "Re-authenticate"
                : isReinstall
                  ? "Reinstall Server"
                  : "Install Server"}
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
            <Button
              type="submit"
              disabled={!isValid || hasRegexErrors || isInstalling}
            >
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
        <InlineNotice variant="neutral">
          <KeyRound />
          <InlineNoticeText>
            Replace credentials for this existing connection only. Tool
            assignments and policies stay unchanged. Use Manage credentials to
            add or remove connections.
          </InlineNoticeText>
        </InlineNotice>
      )}

      {isReinstall && (
        <InlineNotice>
          <AlertTriangle />
          <InlineNoticeText>
            This server's catalog now requires values that weren't asked for at
            install time. Provide them below to finish the reinstall; existing
            tool assignments are preserved.
          </InlineNoticeText>
        </InlineNotice>
      )}

      <SelectMcpServerCredentialTypeAndTeams
        onTeamChange={setSelectedTeamId}
        catalogId={catalogItem?.id}
        onScopeChange={setScope}
        onCanInstallChange={setCanInstall}
        isReinstall={isReinstall}
        isReauth={isReauth}
        existingScope={existingScope}
        existingTeamId={existingTeamId}
        preselectedTeamId={preselectedTeamId}
        personalOnly={personalOnly}
        orgOnly={orgOnly}
      />

      {canInstall && hasOAuth && usesBrowserOAuth && (
        <InlineNotice variant="info">
          <Info />
          <InlineNoticeText>
            This server requires OAuth authentication. You'll be redirected to
            complete the authentication flow after clicking Install.
          </InlineNoticeText>
        </InlineNotice>
      )}

      {canInstall && hasOAuth && !usesBrowserOAuth && (
        <InlineNotice variant="info">
          <Info />
          <InlineNoticeText>
            This server uses shared OAuth client credentials. The values below
            are stored with the installation, and {catalogItem.name} will fetch
            short-lived bearer tokens automatically when tools run.
          </InlineNoticeText>
        </InlineNotice>
      )}

      {/* Config fields - always show when config exists */}
      {canInstall && hasConfig && (
        <div className="space-y-4">
          {Object.entries(promptableUserConfig).map(
            ([fieldName, fieldConfig]) => (
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

                {fieldConfig.type ===
                "boolean" ? null : fieldConfig.sensitive ? (
                  <SecretInput
                    id={fieldName}
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
                  />
                ) : (
                  <Input
                    id={fieldName}
                    type={fieldConfig.type === "number" ? "number" : "text"}
                    autoComplete={MCP_CONFIG_AUTOCOMPLETE}
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
                    aria-invalid={
                      configRegexError(fieldName, fieldConfig.type)
                        ? true
                        : undefined
                    }
                  />
                )}
                {!fieldConfig.sensitive &&
                  configRegexError(fieldName, fieldConfig.type) && (
                    <p className="text-xs text-destructive">
                      {configRegexError(fieldName, fieldConfig.type)}
                    </p>
                  )}
              </div>
            ),
          )}
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
    </FormShell>
  );
}
