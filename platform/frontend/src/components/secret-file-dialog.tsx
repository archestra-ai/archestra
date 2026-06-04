"use client";

import { parseVaultReference } from "@shared";
import { CheckCircle2, Info, Key, Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  FieldScopeSelect,
  type FieldScopeValue,
} from "@/components/field-scope-select";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MCP_SECRET_AUTOCOMPLETE } from "@/lib/mcp/mcp-form-autocomplete";

const ExternalSecretSelector = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("@/components/external-secret-selector.ee"),
);

export interface SecretFileDraft {
  key: string;
  scope: FieldScopeValue;
  required: boolean;
  value: string;
  description: string;
}

interface SecretFileDialogProps {
  open: boolean;
  mode: "add" | "edit";
  initial: SecretFileDraft | null;
  existingKeys: string[];
  secretKeysWithStoredValue?: Set<string>;
  useExternalSecretsManager?: boolean;
  disableInstallation?: boolean;
  disableInstallationReason?: string;
  onClose: () => void;
  onConfirm: (draft: SecretFileDraft) => void;
}

function makeEmptyDraft(disableInstallation: boolean): SecretFileDraft {
  return {
    key: "",
    scope: disableInstallation ? "static" : "installation",
    required: !disableInstallation,
    value: "",
    description: "",
  };
}

export function SecretFileDialog({
  open,
  mode,
  initial,
  existingKeys,
  secretKeysWithStoredValue,
  useExternalSecretsManager = false,
  disableInstallation = false,
  disableInstallationReason,
  onClose,
  onConfirm,
}: SecretFileDialogProps) {
  const [draft, setDraft] = useState<SecretFileDraft>(
    initial ?? makeEmptyDraft(disableInstallation),
  );
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);

  useEffect(() => {
    if (open) setDraft(initial ?? makeEmptyDraft(disableInstallation));
  }, [open, initial, disableInstallation]);

  const trimmedKey = draft.key.trim();
  const duplicate = useMemo(
    () => existingKeys.includes(trimmedKey) && trimmedKey.length > 0,
    [existingKeys, trimmedKey],
  );

  const hasStoredSecret =
    mode === "edit" && secretKeysWithStoredValue?.has(trimmedKey) === true;

  const isVaultRef =
    useExternalSecretsManager &&
    draft.scope === "static" &&
    draft.value.length > 0;

  const valueRequired = draft.scope === "static" && !hasStoredSecret;
  const canSubmit =
    trimmedKey.length > 0 &&
    !duplicate &&
    (!valueRequired || draft.value.trim().length > 0);

  function updateDraft(patch: Partial<SecretFileDraft>) {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      if (patch.scope === "installation") next.required = true;
      else if (patch.scope) next.required = false;
      if (patch.scope && patch.scope !== "static") next.value = "";
      return next;
    });
  }

  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="small"
      title={mode === "add" ? "Add secret file" : "Edit secret file"}
      description={
        mode === "add"
          ? "Mounted as a file at /secrets/<key> inside the server pod."
          : undefined
      }
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => onConfirm({ ...draft, key: trimmedKey })}
          >
            {mode === "add" ? "Add file" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="secret-file-key">File name</Label>
          <Input
            id="secret-file-key"
            value={draft.key}
            onChange={(e) => updateDraft({ key: e.target.value })}
            placeholder="TLS_CERT"
            className="font-mono"
          />
          {duplicate && (
            <p className="text-xs text-destructive">
              A secret file named &quot;{trimmedKey}&quot; already exists.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label>Scope</Label>
          <FieldScopeSelect
            value={draft.scope}
            onChange={(scope) => updateDraft({ scope })}
            disableInstallation={disableInstallation}
            disabledReason={disableInstallationReason}
          />
        </div>

        {draft.scope === "installation" && (
          <ScopeCallout
            title="The user provides this when installing"
            body={
              <>
                They&apos;ll see a field labeled{" "}
                <span className="font-mono">
                  &quot;{trimmedKey || "FILE_NAME"}&quot;
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
            onOpenVault={() => setVaultDialogOpen(true)}
            onClearVault={() => updateDraft({ value: "" })}
            onValueChange={(value) => updateDraft({ value })}
          />
        )}

        {draft.scope === "installation" && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">Required file</div>
              <div className="text-xs text-muted-foreground">
                Block installation until the user supplies a value.
              </div>
            </div>
            <Switch
              checked={draft.required}
              onCheckedChange={(required) => updateDraft({ required })}
              aria-label="Required file"
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="secret-file-description">Description</Label>
          <Textarea
            id="secret-file-description"
            value={draft.description}
            onChange={(e) => updateDraft({ description: e.target.value })}
            placeholder="Optional description"
            rows={2}
          />
        </div>
      </div>

      {useExternalSecretsManager && vaultDialogOpen && (
        <VaultPickerDialog
          envKey={trimmedKey || "field"}
          initialValue={isVaultRef ? draft.value : undefined}
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

function StaticValueEditor({
  draft,
  hasStoredSecret,
  isVaultRef,
  useExternalSecretsManager,
  onOpenVault,
  onClearVault,
  onValueChange,
}: {
  draft: SecretFileDraft;
  hasStoredSecret: boolean;
  isVaultRef: boolean;
  useExternalSecretsManager: boolean;
  onOpenVault: () => void;
  onClearVault: () => void;
  onValueChange: (value: string) => void;
}) {
  if (useExternalSecretsManager) {
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

  return (
    <div className="space-y-2">
      <Label htmlFor="secret-file-value">File contents</Label>
      <Textarea
        id="secret-file-value"
        value={draft.value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={hasStoredSecret ? "••••••••" : "Paste the secret here..."}
        rows={6}
        className="font-mono text-xs"
        autoComplete={MCP_SECRET_AUTOCOMPLETE}
      />
      {hasStoredSecret && (
        <p className="text-xs text-muted-foreground">
          A value is already stored. Leave blank to keep it, or paste a new
          value to replace.
        </p>
      )}
    </div>
  );
}

function VaultPickerDialog({
  envKey,
  initialValue,
  onClose,
  onConfirm,
}: {
  envKey: string;
  initialValue: string | undefined;
  onClose: () => void;
  onConfirm: (ref: string) => void;
}) {
  const parsed = initialValue ? parseVaultReference(initialValue) : null;
  const [teamId, setTeamId] = useState<string | null>(null);
  const [secretPath, setSecretPath] = useState<string | null>(
    parsed?.path ?? null,
  );
  const [secretKey, setSecretKey] = useState<string | null>(
    parsed?.key ?? null,
  );

  return (
    <StandardDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="small"
      title={
        <span className="flex items-center gap-2">
          <Key className="h-5 w-5" />
          Set external secret
          <span className="font-mono text-muted-foreground">{envKey}</span>
        </span>
      }
      description="Select a secret from your team's external Vault to use for this file."
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (secretPath && secretKey) {
                onConfirm(`${secretPath}#${secretKey}`);
              }
            }}
            disabled={!secretPath || !secretKey}
          >
            Confirm
          </Button>
        </>
      }
    >
      <Suspense
        fallback={
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading...
          </div>
        }
      >
        <ExternalSecretSelector
          selectedTeamId={teamId}
          selectedSecretPath={secretPath}
          selectedSecretKey={secretKey}
          onTeamChange={setTeamId}
          onSecretChange={setSecretPath}
          onSecretKeyChange={setSecretKey}
        />
      </Suspense>
    </StandardDialog>
  );
}
