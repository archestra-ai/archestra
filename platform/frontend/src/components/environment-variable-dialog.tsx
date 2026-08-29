"use client";

import { E2eTestId, parseVaultReference } from "@archestra/shared";
import { CheckCircle2, Info, Key } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import {
  FieldScopeSelect,
  type FieldScopeValue,
} from "@/components/field-scope-select";
import { StandardDialog } from "@/components/standard-dialog";
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
import { MCP_CONFIG_AUTOCOMPLETE } from "@/lib/mcp/mcp-form-autocomplete";

export type EnvVarType = "plain_text" | "secret" | "boolean" | "number";

export interface EnvVarDraft {
  key: string;
  type: EnvVarType;
  scope: FieldScopeValue;
  required: boolean;
  description: string;
  value: string;
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

  const canSubmit =
    trimmedKey.length > 0 &&
    !duplicate &&
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
      }
      return next;
    });
  }

  function submit() {
    if (!canSubmit) return;
    onConfirm({ ...draft, key: trimmedKey });
  }

  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="small"
      title={
        mode === "add"
          ? "Add environment variable"
          : "Edit environment variable"
      }
      description={
        mode === "add"
          ? `Configure how this variable is supplied to the ${targetLabel}.`
          : undefined
      }
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {mode === "add" ? "Add variable" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
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

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="env-var-type">Type</Label>
            <Select
              value={draft.type}
              onValueChange={(v) => updateDraft({ type: v as EnvVarType })}
            >
              <SelectTrigger
                id="env-var-type"
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
            <Label>Scope</Label>
            <FieldScopeSelect
              value={draft.scope}
              onChange={(scope) => updateDraft({ scope })}
              disableInstallation={disableInstallation}
              disabledReason={disableInstallationReason}
              installationLabel={installationLabel}
              staticLabel={staticLabel}
            />
          </div>
        </div>

        {(draft.scope === "installation" ||
          (allowRequiredStaticSecret &&
            draft.scope === "static" &&
            draft.type === "secret")) && (
          <ScopeCallout
            title={installationCalloutTitle}
            body={
              <>
                They&apos;ll see a field labeled{" "}
                <span className="font-mono">
                  &quot;{trimmedKey || "KEY"}&quot;
                </span>{" "}
                and your description below as the helper text.
              </>
            }
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

        <div className="space-y-2">
          <Label htmlFor="env-var-description">Description</Label>
          <Textarea
            id="env-var-description"
            value={draft.description}
            onChange={(e) => updateDraft({ description: e.target.value })}
            placeholder="Optional description"
            rows={2}
          />
        </div>
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
    </StandardDialog>
  );
}

function ScopeCallout({
  title,
  body,
}: {
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-primary/20 bg-primary/5 p-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="space-y-0.5 text-xs">
        <div className="font-medium text-foreground">{title}</div>
        <div className="text-muted-foreground">{body}</div>
      </div>
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
    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Required variable</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch
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
