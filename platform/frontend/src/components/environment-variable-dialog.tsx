"use client";

import { E2eTestId, parseVaultReference } from "@archestra/shared";
import { CheckCircle2, Key } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExecutionCredentialIcon } from "@/components/execution-credential-icon";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import {
  FieldScopeSelect,
  type FieldScopeValue,
} from "@/components/field-scope-select";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { MCP_CONFIG_AUTOCOMPLETE } from "@/lib/mcp/mcp-form-autocomplete";

export type EnvVarType = "plain_text" | "secret" | "boolean" | "number";

export interface EnvVarDraft {
  key: string;
  type: EnvVarType;
  scope: FieldScopeValue;
  required: boolean;
  description: string;
  value: string;
  /** Stable reusable connection id for Agent Background execution secrets. */
  credentialId?: string;
}

export interface CredentialBindingOption {
  id: string;
  label: string;
  description: string;
  icon?: string | null;
  defaultKey: string;
  allowedScopes: readonly FieldScopeValue[];
}

export type EnvironmentVariableDialogMode = "add" | "edit";

interface EnvironmentVariableDialogProps {
  open: boolean;
  mode: EnvironmentVariableDialogMode;
  initial: EnvVarDraft | null;
  existingKeys: string[];
  secretKeysWithStoredValue?: Set<string>;
  useExternalSecretsManager?: boolean;
  disableInstallation?: boolean;
  disableInstallationReason?: string;
  targetLabel?: string;
  installationLabel?: string;
  staticLabel?: string;
  installationCalloutTitle?: string;
  requiredDescription?: string;
  deferStaticSecretValue?: boolean;
  installationOnlyForSecrets?: boolean;
  allowRequiredStaticSecret?: boolean;
  normalizeKey?: (key: string) => string;
  credentialBindingOptions?: readonly CredentialBindingOption[];
  /**
   * Optional validator for a static plain-text value (e.g. an environment's
   * allowlist regex). Returns an error message to show under the value input
   * and block confirm, or null when the value is allowed.
   */
  validateValue?: (value: string) => string | null;
  onClose: () => void;
  onConfirm: (draft: EnvVarDraft) => void;
}

function makeEmptyDraft(
  disableInstallation: boolean,
  installationOnlyForSecrets: boolean,
): EnvVarDraft {
  return {
    key: "",
    type: "plain_text",
    scope:
      disableInstallation || installationOnlyForSecrets
        ? "static"
        : "installation",
    required: !disableInstallation && !installationOnlyForSecrets,
    description: "",
    value: "",
    credentialId: undefined,
  };
}

export function EnvironmentVariableDialog({
  open,
  mode,
  initial,
  existingKeys,
  secretKeysWithStoredValue,
  useExternalSecretsManager = false,
  disableInstallation = false,
  disableInstallationReason,
  targetLabel = "MCP server",
  installationLabel = "Installation",
  staticLabel = "Static",
  installationCalloutTitle = "The user enters this when installing",
  requiredDescription = "Block installation until the user supplies a value.",
  deferStaticSecretValue = false,
  installationOnlyForSecrets = false,
  allowRequiredStaticSecret = false,
  normalizeKey = identity,
  credentialBindingOptions,
  validateValue,
  onClose,
  onConfirm,
}: EnvironmentVariableDialogProps) {
  const [draft, setDraft] = useState<EnvVarDraft>(
    initial ?? makeEmptyDraft(disableInstallation, installationOnlyForSecrets),
  );
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(
        initial ??
          makeEmptyDraft(disableInstallation, installationOnlyForSecrets),
      );
    }
  }, [open, initial, disableInstallation, installationOnlyForSecrets]);

  const trimmedKey = normalizeKey(draft.key.trim());
  const duplicate = useMemo(
    () => existingKeys.includes(trimmedKey) && trimmedKey.length > 0,
    [existingKeys, trimmedKey],
  );

  const hasStoredSecret =
    mode === "edit" &&
    draft.type === "secret" &&
    secretKeysWithStoredValue?.has(trimmedKey) === true;

  const isVaultRef =
    useExternalSecretsManager &&
    draft.type === "secret" &&
    draft.scope === "static" &&
    draft.value.length > 0;

  const valueRequired =
    draft.scope === "static" &&
    !hasStoredSecret &&
    !(draft.type === "boolean") &&
    !(deferStaticSecretValue && draft.type === "secret");

  // Apply the environment's allowlist rule to free-text values only: a static,
  // plain-text value the user actually typed. Secrets and number/boolean types
  // are exempt (the rule targets free-text), mirroring the install dialogs.
  const valueError =
    validateValue &&
    draft.scope === "static" &&
    draft.type === "plain_text" &&
    draft.value.length > 0
      ? validateValue(draft.value)
      : null;
  const requiresCredentialBinding =
    draft.type === "secret" && !!credentialBindingOptions;
  const activeCredentialBinding = credentialBindingOptions?.find(
    (option) => option.id === draft.credentialId,
  );
  const credentialIdError =
    requiresCredentialBinding &&
    draft.credentialId !== undefined &&
    !/^[a-z][a-z0-9._-]*$/.test(draft.credentialId);

  const canSubmit =
    trimmedKey.length > 0 &&
    !duplicate &&
    !credentialIdError &&
    !valueError &&
    (!valueRequired || draft.value.trim().length > 0);

  function updateDraft(patch: Partial<EnvVarDraft>) {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      if (patch.scope === "installation") {
        next.required = true;
        if (installationOnlyForSecrets) next.type = "secret";
      } else if (
        patch.scope &&
        !(allowRequiredStaticSecret && next.type === "secret")
      ) {
        next.required = false;
      }
      if (patch.scope && patch.scope !== "static") {
        next.value = "";
      }
      if (patch.type && patch.type !== prev.type) {
        next.value = patch.type === "boolean" ? "false" : "";
        if (installationOnlyForSecrets && patch.type !== "secret") {
          next.scope = "static";
          next.required = false;
        } else if (
          allowRequiredStaticSecret &&
          patch.type === "secret" &&
          next.scope === "static"
        ) {
          next.required = true;
        }
        if (patch.type !== "secret") next.credentialId = undefined;
      }
      const binding = credentialBindingOptions?.find(
        (option) => option.id === next.credentialId,
      );
      if (binding && !binding.allowedScopes.includes(next.scope)) {
        const [scope] = binding.allowedScopes;
        next.scope = scope;
        next.required = scope === "installation";
        next.value = "";
      }
      return next;
    });
  }

  function submit() {
    if (!canSubmit) return;
    onConfirm({ ...draft, key: trimmedKey });
  }

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="small"
      className="sm:max-w-xl"
      isDirty={hasDraftChanged(
        draft,
        initial ??
          makeEmptyDraft(disableInstallation, installationOnlyForSecrets),
      )}
      title={
        mode === "add"
          ? "Add environment variable"
          : "Edit environment variable"
      }
      description={`Configure the key, value source, and availability for the ${targetLabel}.`}
      onSubmit={submit}
      footer={
        <>
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button type="submit" disabled={!canSubmit}>
            {mode === "add" ? "Add variable" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="env-var-key">Key</Label>
          <Input
            id="env-var-key"
            value={draft.key}
            onChange={(e) => updateDraft({ key: normalizeKey(e.target.value) })}
            placeholder="API_KEY"
            className="font-mono"
            autoComplete={MCP_CONFIG_AUTOCOMPLETE}
          />
          {duplicate && (
            <p className="text-xs text-destructive">
              A variable named &quot;{trimmedKey}&quot; already exists.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="env-var-description">Description</Label>
          <Textarea
            id="env-var-description"
            value={draft.description}
            onChange={(e) => updateDraft({ description: e.target.value })}
            placeholder="What this variable is used for"
            rows={2}
          />
          {(draft.scope === "installation" ||
            (allowRequiredStaticSecret &&
              draft.scope === "static" &&
              draft.type === "secret")) && (
            <p className="text-xs text-muted-foreground">
              Shown as helper text when &quot;{trimmedKey || "KEY"}&quot; is
              requested.
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="env-var-type">Type</Label>
            <Select
              value={draft.type}
              onValueChange={(v) => updateDraft({ type: v as EnvVarType })}
            >
              <SelectTrigger
                id="env-var-type"
                className="w-full"
                data-testid={E2eTestId.SelectEnvironmentVariableType}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="plain_text">Plain text</SelectItem>
                <SelectItem value="secret">Secret</SelectItem>
                <SelectItem value="boolean">Boolean</SelectItem>
                <SelectItem value="number">Number</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="env-var-scope">Availability</Label>
            <FieldScopeSelect
              id="env-var-scope"
              value={draft.scope}
              onChange={(scope) => updateDraft({ scope })}
              disabled={activeCredentialBinding?.allowedScopes.length === 1}
              disableInstallation={disableInstallation}
              disabledReason={disableInstallationReason}
              installationLabel={installationLabel}
              staticLabel={staticLabel}
            />
            {draft.scope === "installation" && (
              <p className="text-xs text-muted-foreground">
                {installationCalloutTitle}.
              </p>
            )}
          </div>
        </div>

        {requiresCredentialBinding && (
          <CredentialBindingEditor
            draft={draft}
            options={credentialBindingOptions}
            onChange={updateDraft}
          />
        )}

        {draft.scope === "static" && (
          <StaticValueEditor
            draft={draft}
            hasStoredSecret={hasStoredSecret}
            isVaultRef={isVaultRef}
            useExternalSecretsManager={useExternalSecretsManager}
            valueError={valueError}
            onOpenVault={() => setVaultDialogOpen(true)}
            onClearVault={() => updateDraft({ value: "" })}
            onValueChange={(value) => updateDraft({ value })}
            deferSecretValue={deferStaticSecretValue}
          />
        )}

        {draft.scope === "installation" && (
          <RequiredToggleCard
            checked={draft.required}
            onChange={(required) => updateDraft({ required })}
            description={requiredDescription}
          />
        )}
      </div>

      {useExternalSecretsManager && vaultDialogOpen && (
        <ExternalSecretReferenceDialog
          fieldLabel={trimmedKey || "field"}
          initialValue={isVaultRef ? draft.value : undefined}
          description="Select a secret from your team's external Vault to use for this environment variable."
          onClose={() => setVaultDialogOpen(false)}
          onConfirm={(ref) => {
            updateDraft({ value: ref });
            setVaultDialogOpen(false);
          }}
        />
      )}
    </StandardFormDialog>
  );
}

function CredentialBindingEditor({
  draft,
  options,
  onChange,
}: {
  draft: EnvVarDraft;
  options: readonly CredentialBindingOption[];
  onChange: (patch: Partial<EnvVarDraft>) => void;
}) {
  const reserved = options.find((option) => option.id === draft.credentialId);
  const selection = reserved?.id ?? "one-off";
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor="env-var-credential-binding">Secret source</Label>
        <p className="text-xs text-muted-foreground">
          {reserved
            ? "Uses a saved connection. Rotating it updates every Agent that uses it."
            : "Saved for this Agent only."}{" "}
          <Link
            href="/settings/agents#execution-credentials"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Manage saved connections
          </Link>
        </p>
      </div>
      <Select
        value={selection}
        onValueChange={(value) => {
          const option = options.find((entry) => entry.id === value);
          const scope = option?.allowedScopes.includes(draft.scope)
            ? draft.scope
            : option?.allowedScopes[0];
          onChange(
            option
              ? {
                  credentialId: option.id,
                  key: draft.key || option.defaultKey,
                  description: draft.description || option.description,
                  scope,
                }
              : { credentialId: undefined },
          );
        }}
      >
        <SelectTrigger id="env-var-credential-binding" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          position="popper"
          className="w-[var(--radix-select-trigger-width)]"
        >
          {options.map((option) => (
            <SelectItem
              key={option.id}
              value={option.id}
              description={
                option.description ? (
                  <span className="line-clamp-2 whitespace-normal">
                    {option.description}
                  </span>
                ) : undefined
              }
              icon={<ExecutionCredentialIcon icon={option.icon ?? null} />}
            >
              {option.label}
            </SelectItem>
          ))}
          <SelectItem
            value="one-off"
            description={
              <span className="line-clamp-2 whitespace-normal">
                Only this Agent can use this saved value.
              </span>
            }
          >
            Agent-specific secret
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function RequiredToggleCard({
  checked,
  onChange,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  description: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor="env-var-required">Required variable</Label>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch
        id="env-var-required"
        className="shrink-0"
        checked={checked}
        onCheckedChange={onChange}
        aria-label="Required variable"
      />
    </div>
  );
}

function StaticValueEditor({
  draft,
  hasStoredSecret,
  isVaultRef,
  useExternalSecretsManager,
  valueError,
  onOpenVault,
  onClearVault,
  onValueChange,
  deferSecretValue,
}: {
  draft: EnvVarDraft;
  hasStoredSecret: boolean;
  isVaultRef: boolean;
  useExternalSecretsManager: boolean;
  valueError: string | null;
  onOpenVault: () => void;
  onClearVault: () => void;
  onValueChange: (value: string) => void;
  deferSecretValue: boolean;
}) {
  if (deferSecretValue && draft.type === "secret") {
    if (draft.credentialId) return null;
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        The secret value is configured after saving and is never stored in this
        deployment definition.
      </div>
    );
  }

  if (useExternalSecretsManager && draft.type === "secret") {
    return (
      <div className="space-y-2">
        <Label>Vault secret</Label>
        {isVaultRef ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs font-mono text-green-600 hover:text-green-700"
              onClick={onOpenVault}
            >
              <CheckCircle2 className="h-3 w-3 mr-1" />
              <span className="truncate max-w-[200px]">
                {parseVaultReference(draft.value).key}
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={onClearVault}
            >
              Clear
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={onOpenVault}
          >
            <Key className="h-3 w-3 mr-1" />
            Set secret
          </Button>
        )}
      </div>
    );
  }

  if (draft.type === "boolean") {
    const checked = draft.value === "true";
    return (
      <Label className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2.5 hover:bg-muted/30">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onValueChange(v === true ? "true" : "false")}
        />
        <span className="text-sm">Value</span>
        <span className="font-mono text-xs text-muted-foreground">
          {checked ? "true" : "false"}
        </span>
      </Label>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="env-var-value">Value</Label>
      <SecretInput
        id="env-var-value"
        masked={draft.type === "secret"}
        inputMode={draft.type === "number" ? "numeric" : undefined}
        value={draft.value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={hasStoredSecret ? "••••••••" : "your-value"}
        className="font-mono"
        aria-invalid={valueError ? true : undefined}
      />
      {valueError && <p className="text-xs text-destructive">{valueError}</p>}
      {hasStoredSecret && (
        <p className="text-xs text-muted-foreground">
          A value is already stored. Leave blank to keep it, or enter a new
          value to replace.
        </p>
      )}
    </div>
  );
}

function identity(value: string): string {
  return value;
}

function hasDraftChanged(current: EnvVarDraft, initial: EnvVarDraft) {
  return (
    current.key !== initial.key ||
    current.type !== initial.type ||
    current.scope !== initial.scope ||
    current.required !== initial.required ||
    current.description !== initial.description ||
    current.value !== initial.value ||
    current.credentialId !== initial.credentialId
  );
}
