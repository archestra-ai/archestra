"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import {
  type CredentialBindingOption,
  EnvironmentVariableDialog,
  type EnvVarDraft,
} from "@/components/environment-variable-dialog";
import {
  EnvironmentVariablesTable,
  type EnvironmentVariableTableRow,
} from "@/components/environment-variables-read-only-table";
import { Button } from "@/components/ui/button";

interface DeploymentEnvironmentVariablesEditorProps {
  value: EnvVarDraft[];
  onChange: (value: EnvVarDraft[]) => void;
  description: string;
  targetLabel: string;
  installationLabel: string;
  staticLabel: string;
  installationCalloutTitle: string;
  requiredDescription: string;
  promptedValueLabel: string;
  deferStaticSecretValue?: boolean;
  installationOnlyForSecrets?: boolean;
  allowRequiredStaticSecret?: boolean;
  normalizeKey?: (key: string) => string;
  credentialBindingOptions?: readonly CredentialBindingOption[];
}

export function DeploymentEnvironmentVariablesEditor({
  value,
  onChange,
  description,
  targetLabel,
  installationLabel,
  staticLabel,
  installationCalloutTitle,
  requiredDescription,
  promptedValueLabel,
  deferStaticSecretValue = false,
  installationOnlyForSecrets = false,
  allowRequiredStaticSecret = false,
  normalizeKey,
  credentialBindingOptions,
}: DeploymentEnvironmentVariablesEditorProps) {
  const [dialog, setDialog] = useState<
    { mode: "add" } | { mode: "edit"; index: number } | null
  >(null);

  const rows: EnvironmentVariableTableRow[] = value.map((entry, index) => ({
    id: `${entry.key}-${index}`,
    ...entry,
  }));

  return (
    <div className="space-y-1">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="font-semibold text-base">Environment variables</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDialog({ mode: "add" })}
        >
          <Plus className="h-4 w-4" />
          Add variable
        </Button>
      </div>

      {value.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No environment variables configured.
        </div>
      ) : (
        <EnvironmentVariablesTable
          rows={rows}
          promptedValueLabel={promptedValueLabel}
          onEdit={(index) => setDialog({ mode: "edit", index })}
          onDelete={(index) => onChange(value.filter((_, i) => i !== index))}
        />
      )}

      <EnvironmentVariableDialog
        open={dialog !== null}
        mode={dialog?.mode === "edit" ? "edit" : "add"}
        initial={dialog?.mode === "edit" ? value[dialog.index] : null}
        existingKeys={value
          .filter((_, index) =>
            dialog?.mode === "edit" ? index !== dialog.index : true,
          )
          .map((entry) => entry.key)}
        targetLabel={targetLabel}
        installationLabel={installationLabel}
        staticLabel={staticLabel}
        installationCalloutTitle={installationCalloutTitle}
        requiredDescription={requiredDescription}
        deferStaticSecretValue={deferStaticSecretValue}
        installationOnlyForSecrets={installationOnlyForSecrets}
        allowRequiredStaticSecret={allowRequiredStaticSecret}
        normalizeKey={normalizeKey}
        credentialBindingOptions={credentialBindingOptions}
        onClose={() => setDialog(null)}
        onConfirm={(draft) => {
          if (dialog?.mode === "edit") {
            onChange(
              value.map((entry, index) =>
                index === dialog.index ? draft : entry,
              ),
            );
          } else {
            onChange([...value, draft]);
          }
          setDialog(null);
        }}
      />
    </div>
  );
}
