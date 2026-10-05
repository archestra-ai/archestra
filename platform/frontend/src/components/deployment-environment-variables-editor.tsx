"use client";

import { type ReactNode, useState } from "react";
import {
  AddListItemButton,
  EmptyListState,
} from "@/components/empty-list-state";
import {
  type CredentialBindingOption,
  EnvironmentVariableDialog,
  type EnvVarDraft,
} from "@/components/environment-variable-dialog";
import {
  EnvironmentVariablesTable,
  type EnvironmentVariableTableRow,
} from "@/components/environment-variables-read-only-table";

interface DeploymentEnvironmentVariablesEditorProps {
  hideHeading?: boolean;
  value: EnvVarDraft[];
  onChange: (value: EnvVarDraft[]) => void;
  description: ReactNode;
  targetLabel: string;
  installationLabel: string;
  staticLabel: string;
  installationDescription?: string;
  staticDescription?: string;
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
  hideHeading = false,
  value,
  onChange,
  description,
  targetLabel,
  installationLabel,
  staticLabel,
  installationDescription,
  staticDescription,
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

  const addButton = (
    <AddListItemButton
      label="Add variable"
      onClick={() => setDialog({ mode: "add" })}
    />
  );

  return (
    <div className="space-y-3">
      {(!hideHeading || description) && (
        <div className="space-y-1">
          {!hideHeading && (
            <h3 className="font-semibold text-base">Environment variables</h3>
          )}
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      )}

      {value.length === 0 ? (
        <EmptyListState
          message="No environment variables yet."
          action={addButton}
        />
      ) : (
        <>
          <EnvironmentVariablesTable
            rows={rows}
            credentialLabels={Object.fromEntries(
              (credentialBindingOptions ?? []).map((option) => [
                option.id,
                option.label,
              ]),
            )}
            credentialSources={Object.fromEntries(
              (credentialBindingOptions ?? []).map((option) => [
                option.id,
                { icon: option.icon, label: option.sourceLabel },
              ]),
            )}
            promptedValueLabel={promptedValueLabel}
            onEdit={(index) => setDialog({ mode: "edit", index })}
            onDelete={(index) => onChange(value.filter((_, i) => i !== index))}
          />
          {addButton}
        </>
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
        installationDescription={installationDescription}
        staticDescription={staticDescription}
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
