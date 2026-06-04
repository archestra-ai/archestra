"use client";

import { parseVaultReference } from "@shared";
import { Key, Loader2, Plus, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type {
  FieldArrayWithId,
  FieldPath,
  FieldValues,
  PathValue,
  UseFieldArrayAppend,
  UseFieldArrayRemove,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
import {
  EnvFromDialog,
  type EnvFromDraft,
  type EnvFromType,
} from "@/components/env-from-dialog";
import {
  EnvironmentVariableDialog,
  type EnvVarDraft,
} from "@/components/environment-variable-dialog";
import { EnvironmentVariablesReadOnlyTable } from "@/components/environment-variables-read-only-table";
import {
  SecretFileDialog,
  type SecretFileDraft,
} from "@/components/secret-file-dialog";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { FormDescription, FormLabel } from "@/components/ui/form";

const ExternalSecretSelector = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("@/components/external-secret-selector.ee"),
);

interface ExternalSecretValue {
  teamId: string | null;
  secretPath: string | null;
  secretKey: string | null;
}

interface EnvironmentVariablesFormFieldProps<TFieldValues extends FieldValues> {
  // biome-ignore lint/suspicious/noExplicitAny: Generic field array types require any for flexibility
  fields: FieldArrayWithId<TFieldValues, any, "id">[];
  // biome-ignore lint/suspicious/noExplicitAny: Generic field array types require any for flexibility
  append: UseFieldArrayAppend<TFieldValues, any>;
  remove: UseFieldArrayRemove;
  fieldNamePrefix: string;
  form: {
    watch: UseFormWatch<TFieldValues>;
    setValue: UseFormSetValue<TFieldValues>;
  };
  showLabel?: boolean;
  showDescription?: boolean;
  /** Optional inline content rendered after the "Environment Variables" heading. */
  labelSuffix?: React.ReactNode;
  /** When true, non-prompted secret values will be sourced from external secrets manager (Vault) */
  useExternalSecretsManager?: boolean;
  /**
   * Set of env-var keys whose secret value is already stored on the server.
   * Rows whose `key` is in this set render `••••••••` + an Update button
   * instead of an empty input, so admins don't think the value has been wiped.
   */
  secretKeysWithStoredValue?: Set<string>;
  /** When true, the "Prompt on each installation" checkbox is disabled (e.g. multi-tenant servers) */
  disablePromptOnInstallation?: boolean;
  /** Tooltip message shown when the "Prompt on each installation" checkbox is disabled */
  disablePromptOnInstallationReason?: string;
  /** Optional envFrom field array for injecting env from K8s Secrets/ConfigMaps */
  envFrom?: {
    // biome-ignore lint/suspicious/noExplicitAny: Generic field array types require any for flexibility
    fields: FieldArrayWithId<any, any, "id">[];
    append: (value: {
      type: "secret" | "configMap";
      name: string;
      prefix: string;
    }) => void;
    remove: (index: number) => void;
    // biome-ignore lint/suspicious/noExplicitAny: Generic form watch/setValue/register require any
    watch: (name: any) => any;
    setValue: (
      // biome-ignore lint/suspicious/noExplicitAny: Generic form watch/setValue/register require any
      name: any,
      // biome-ignore lint/suspicious/noExplicitAny: Generic form watch/setValue/register require any
      value: any,
      options?: { shouldDirty: boolean },
    ) => void;
    // biome-ignore lint/suspicious/noExplicitAny: Generic form watch/setValue/register require any
    register: (name: any) => any;
    fieldNamePrefix: string;
  };
}

export function EnvironmentVariablesFormField<
  TFieldValues extends FieldValues,
>({
  fields,
  append,
  remove,
  fieldNamePrefix,
  form,
  showLabel = true,
  showDescription = true,
  labelSuffix,
  useExternalSecretsManager = false,
  secretKeysWithStoredValue,
  disablePromptOnInstallation = false,
  disablePromptOnInstallationReason,
  envFrom,
}: EnvironmentVariablesFormFieldProps<TFieldValues>) {
  const [dialogOpenForEnvIndex, setDialogOpenForEnvIndex] = useState<
    number | null
  >(null);
  const [envVarDialog, setEnvVarDialog] = useState<
    { mode: "add" } | { mode: "edit"; index: number } | null
  >(null);
  const [envFromDialog, setEnvFromDialog] = useState<
    { mode: "add" } | { mode: "edit"; index: number } | null
  >(null);
  const [secretFileDialog, setSecretFileDialog] = useState<
    { mode: "add" } | { mode: "edit"; index: number } | null
  >(null);

  const handleSecretConfirm = (index: number, value: ExternalSecretValue) => {
    if (value.secretPath && value.secretKey) {
      form.setValue(
        `${fieldNamePrefix}.${index}.value` as FieldPath<TFieldValues>,
        `${value.secretPath}#${value.secretKey}` as PathValue<
          TFieldValues,
          FieldPath<TFieldValues>
        >,
      );
    }
    setDialogOpenForEnvIndex(null);
  };

  const dialogEnvKey =
    dialogOpenForEnvIndex !== null
      ? form.watch(
          `${fieldNamePrefix}.${dialogOpenForEnvIndex}.key` as FieldPath<TFieldValues>,
        )
      : "";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        {showLabel && (
          <h3 className="font-semibold text-base">
            Environment Variables
            {labelSuffix}
          </h3>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setEnvVarDialog({ mode: "add" })}
        >
          <Plus className="h-4 w-4" />
          Add Variable
        </Button>
      </div>
      {/* Filter out mounted secrets - they go in the Secret Files section */}
      {(() => {
        const envVarIndexes = fields
          .map((_, index) => index)
          .filter((index) => {
            const mounted = form.watch(
              `${fieldNamePrefix}.${index}.mounted` as FieldPath<TFieldValues>,
            );
            return !mounted;
          });
        const envVarCount = envVarIndexes.length;

        if (envVarCount === 0) {
          return (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No environment variables configured.
            </div>
          );
        }

        return (
          <>
            {showDescription && (
              <FormDescription className="mb-4 text-xs">
                Configure environment variables for the MCP server. Use "Secret"
                type for sensitive values.
              </FormDescription>
            )}
            {/* TODO(e2e): existing tests in platform/e2e-tests drive the inline
                inputs (placeholder "API_KEY", inline Type Select, inline scope
                checkbox). After this refactor those interactions live in
                EnvironmentVariableDialog — tests must click "Add Variable"
                first, then operate inside the modal. */}
            <EnvironmentVariablesReadOnlyTable
              form={form}
              fields={fields}
              rowIndexes={envVarIndexes}
              fieldNamePrefix={fieldNamePrefix}
              useExternalSecretsManager={useExternalSecretsManager}
              secretKeysWithStoredValue={secretKeysWithStoredValue}
              onEdit={(index) => setEnvVarDialog({ mode: "edit", index })}
              onDelete={(index) => remove(index)}
            />
          </>
        );
      })()}

      <EnvironmentVariableDialog
        open={envVarDialog !== null}
        mode={envVarDialog?.mode === "edit" ? "edit" : "add"}
        initial={
          envVarDialog?.mode === "edit"
            ? readRowAsDraft(form, fieldNamePrefix, envVarDialog.index)
            : null
        }
        existingKeys={readOtherKeys(
          form,
          fieldNamePrefix,
          fields,
          envVarDialog?.mode === "edit" ? envVarDialog.index : null,
        )}
        secretKeysWithStoredValue={secretKeysWithStoredValue}
        useExternalSecretsManager={useExternalSecretsManager}
        disableInstallation={disablePromptOnInstallation}
        disableInstallationReason={disablePromptOnInstallationReason}
        onClose={() => setEnvVarDialog(null)}
        onConfirm={(draft) => {
          if (envVarDialog?.mode === "add") {
            (append as (value: unknown) => void)(draftToRow(draft));
          } else if (envVarDialog?.mode === "edit") {
            applyDraftToRow(form, fieldNamePrefix, envVarDialog.index, draft);
          }
          setEnvVarDialog(null);
        }}
      />

      {/* Environment From k8s Secrets / ConfigMaps Section */}
      {envFrom && (
        <div className="space-y-1 mt-6">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-base">
              Environment From k8s Secrets / ConfigMaps
            </h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEnvFromDialog({ mode: "add" })}
            >
              <Plus className="h-4 w-4" />
              Add Source
            </Button>
          </div>

          {envFrom.fields.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No sources configured.
            </div>
          ) : (
            <>
              <FormDescription className="mb-4 text-xs">
                Inject all keys from existing k8s Secrets or ConfigMaps as
                environment variables.
              </FormDescription>
              <div>
                <div className="grid grid-cols-[160px_1fr_1fr_auto] gap-3 border-b py-2.5 px-4 text-xs font-medium text-foreground">
                  <div>Type</div>
                  <div>Name</div>
                  <div>Prefix</div>
                  <div className="w-9" />
                </div>
                {envFrom.fields.map((field, index) => {
                  const type = envFrom.watch(
                    `${envFrom.fieldNamePrefix}.${index}.type`,
                  ) as EnvFromType | undefined;
                  const name = envFrom.watch(
                    `${envFrom.fieldNamePrefix}.${index}.name`,
                  ) as string | undefined;
                  const prefix = envFrom.watch(
                    `${envFrom.fieldNamePrefix}.${index}.prefix`,
                  ) as string | undefined;
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: row contains a nested delete <button>
                    <div
                      key={field.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setEnvFromDialog({ mode: "edit", index })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setEnvFromDialog({ mode: "edit", index });
                        }
                      }}
                      className="group grid grid-cols-[160px_1fr_1fr_auto] gap-3 items-center border-b py-3 px-4 text-xs last:border-b-0 cursor-pointer hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="text-muted-foreground">
                        {type === "configMap" ? "ConfigMap" : "Secret"}
                      </div>
                      <div className="min-w-0 truncate font-mono">
                        {name || (
                          <span className="text-muted-foreground italic">
                            unnamed
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 truncate font-mono text-muted-foreground">
                        {prefix || <span className="italic">—</span>}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="opacity-60 group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          envFrom.remove(index);
                        }}
                        aria-label="Remove source"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <EnvFromDialog
            open={envFromDialog !== null}
            mode={envFromDialog?.mode === "edit" ? "edit" : "add"}
            initial={
              envFromDialog?.mode === "edit"
                ? readEnvFromRowAsDraft(envFrom, envFromDialog.index)
                : null
            }
            onClose={() => setEnvFromDialog(null)}
            onConfirm={(draft) => {
              if (envFromDialog?.mode === "add") {
                envFrom.append(draft);
              } else if (envFromDialog?.mode === "edit") {
                applyEnvFromDraftToRow(envFrom, envFromDialog.index, draft);
              }
              setEnvFromDialog(null);
            }}
          />
        </div>
      )}

      {/* Secret Files Section */}
      <div className="space-y-1 mt-6">
        <div className="flex items-center justify-between">
          <FormLabel>Secret Files</FormLabel>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSecretFileDialog({ mode: "add" })}
          >
            <Plus className="h-4 w-4" />
            Add Secret File
          </Button>
        </div>
        {(() => {
          const secretFileIndices = fields
            .map((_, index) => index)
            .filter((index) => {
              const mounted = form.watch(
                `${fieldNamePrefix}.${index}.mounted` as FieldPath<TFieldValues>,
              );
              return mounted === true;
            });

          if (secretFileIndices.length === 0) {
            return (
              <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No secret files configured.
              </div>
            );
          }

          return (
            <>
              <FormDescription className="mb-4 text-xs">
                Secrets mounted as files at /secrets/&lt;key&gt;.
              </FormDescription>
              <EnvironmentVariablesReadOnlyTable
                form={form}
                fields={fields}
                rowIndexes={secretFileIndices}
                fieldNamePrefix={fieldNamePrefix}
                useExternalSecretsManager={useExternalSecretsManager}
                secretKeysWithStoredValue={secretKeysWithStoredValue}
                showType={false}
                keyLabel="File"
                removeAriaLabel="Remove secret file"
                onEdit={(index) => setSecretFileDialog({ mode: "edit", index })}
                onDelete={(index) => remove(index)}
              />
            </>
          );
        })()}

        <SecretFileDialog
          open={secretFileDialog !== null}
          mode={secretFileDialog?.mode === "edit" ? "edit" : "add"}
          initial={
            secretFileDialog?.mode === "edit"
              ? readSecretFileRowAsDraft(
                  form,
                  fieldNamePrefix,
                  secretFileDialog.index,
                )
              : null
          }
          existingKeys={readOtherSecretFileKeys(
            form,
            fieldNamePrefix,
            fields,
            secretFileDialog?.mode === "edit" ? secretFileDialog.index : null,
          )}
          secretKeysWithStoredValue={secretKeysWithStoredValue}
          useExternalSecretsManager={useExternalSecretsManager}
          disableInstallation={disablePromptOnInstallation}
          disableInstallationReason={disablePromptOnInstallationReason}
          onClose={() => setSecretFileDialog(null)}
          onConfirm={(draft) => {
            if (secretFileDialog?.mode === "add") {
              (append as (value: unknown) => void)(secretFileDraftToRow(draft));
            } else if (secretFileDialog?.mode === "edit") {
              applySecretFileDraftToRow(
                form,
                fieldNamePrefix,
                secretFileDialog.index,
                draft,
              );
            }
            setSecretFileDialog(null);
          }}
        />
      </div>

      {/* External Secret Selection Dialog */}
      <ExternalSecretDialog
        isOpen={dialogOpenForEnvIndex !== null}
        envKey={dialogEnvKey as string}
        initialValue={
          dialogOpenForEnvIndex !== null
            ? (() => {
                const formValue = form.watch(
                  `${fieldNamePrefix}.${dialogOpenForEnvIndex}.value` as FieldPath<TFieldValues>,
                ) as string | undefined;
                if (formValue) {
                  const parsed = parseVaultReference(formValue as string);
                  return {
                    teamId: null,
                    secretPath: parsed.path,
                    secretKey: parsed.key,
                  };
                }
                return undefined;
              })()
            : undefined
        }
        onConfirm={(value) =>
          dialogOpenForEnvIndex !== null &&
          handleSecretConfirm(dialogOpenForEnvIndex, value)
        }
        onClose={() => setDialogOpenForEnvIndex(null)}
      />
    </div>
  );
}

function readRowAsDraft<TFieldValues extends FieldValues>(
  form: { watch: UseFormWatch<TFieldValues> },
  prefix: string,
  index: number,
): EnvVarDraft {
  const get = <T,>(name: string): T =>
    form.watch(`${prefix}.${index}.${name}` as FieldPath<TFieldValues>) as T;
  const promptOnInstallation = Boolean(get<boolean>("promptOnInstallation"));
  return {
    key: get<string>("key") ?? "",
    type: (get<string>("type") ?? "plain_text") as EnvVarDraft["type"],
    scope: promptOnInstallation ? "installation" : "static",
    required: Boolean(get<boolean>("required")),
    description: get<string>("description") ?? "",
    value: get<string>("value") ?? "",
  };
}

function readOtherKeys<TFieldValues extends FieldValues>(
  form: { watch: UseFormWatch<TFieldValues> },
  prefix: string,
  // biome-ignore lint/suspicious/noExplicitAny: field arrays require generic any
  fields: FieldArrayWithId<TFieldValues, any, "id">[],
  excludeIndex: number | null,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (i === excludeIndex) continue;
    const mounted = form.watch(
      `${prefix}.${i}.mounted` as FieldPath<TFieldValues>,
    );
    if (mounted) continue;
    const k = form.watch(`${prefix}.${i}.key` as FieldPath<TFieldValues>) as
      | string
      | undefined;
    if (k?.trim()) out.push(k.trim());
  }
  return out;
}

function draftToRow(draft: EnvVarDraft) {
  return {
    key: draft.key,
    type: draft.type,
    value: draft.scope === "static" ? draft.value : "",
    promptOnInstallation: draft.scope === "installation",
    required: draft.scope === "installation" ? draft.required : false,
    description: draft.description,
  };
}

function applyDraftToRow<TFieldValues extends FieldValues>(
  form: { setValue: UseFormSetValue<TFieldValues> },
  prefix: string,
  index: number,
  draft: EnvVarDraft,
) {
  const set = (name: string, value: unknown) =>
    form.setValue(
      `${prefix}.${index}.${name}` as FieldPath<TFieldValues>,
      value as PathValue<TFieldValues, FieldPath<TFieldValues>>,
      { shouldDirty: true },
    );
  set("key", draft.key);
  set("type", draft.type);
  set("value", draft.scope === "static" ? draft.value : "");
  set("promptOnInstallation", draft.scope === "installation");
  set("required", draft.scope === "installation" ? draft.required : false);
  set("description", draft.description);
}

type EnvFromApi = NonNullable<
  EnvironmentVariablesFormFieldProps<FieldValues>["envFrom"]
>;

function readEnvFromRowAsDraft(
  envFrom: EnvFromApi,
  index: number,
): EnvFromDraft {
  const prefix = envFrom.fieldNamePrefix;
  return {
    type: (envFrom.watch(`${prefix}.${index}.type`) as EnvFromType) ?? "secret",
    name: (envFrom.watch(`${prefix}.${index}.name`) as string) ?? "",
    prefix: (envFrom.watch(`${prefix}.${index}.prefix`) as string) ?? "",
  };
}

function applyEnvFromDraftToRow(
  envFrom: EnvFromApi,
  index: number,
  draft: EnvFromDraft,
) {
  const p = envFrom.fieldNamePrefix;
  envFrom.setValue(`${p}.${index}.type`, draft.type, { shouldDirty: true });
  envFrom.setValue(`${p}.${index}.name`, draft.name, { shouldDirty: true });
  envFrom.setValue(`${p}.${index}.prefix`, draft.prefix, {
    shouldDirty: true,
  });
}

function readSecretFileRowAsDraft<TFieldValues extends FieldValues>(
  form: { watch: UseFormWatch<TFieldValues> },
  prefix: string,
  index: number,
): SecretFileDraft {
  const get = <T,>(name: string): T =>
    form.watch(`${prefix}.${index}.${name}` as FieldPath<TFieldValues>) as T;
  const promptOnInstallation = Boolean(get<boolean>("promptOnInstallation"));
  return {
    key: get<string>("key") ?? "",
    scope: promptOnInstallation ? "installation" : "static",
    required: Boolean(get<boolean>("required")),
    value: get<string>("value") ?? "",
    description: get<string>("description") ?? "",
  };
}

function readOtherSecretFileKeys<TFieldValues extends FieldValues>(
  form: { watch: UseFormWatch<TFieldValues> },
  prefix: string,
  // biome-ignore lint/suspicious/noExplicitAny: field arrays require generic any
  fields: FieldArrayWithId<TFieldValues, any, "id">[],
  excludeIndex: number | null,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (i === excludeIndex) continue;
    const mounted = form.watch(
      `${prefix}.${i}.mounted` as FieldPath<TFieldValues>,
    );
    if (!mounted) continue;
    const k = form.watch(`${prefix}.${i}.key` as FieldPath<TFieldValues>) as
      | string
      | undefined;
    if (k?.trim()) out.push(k.trim());
  }
  return out;
}

function secretFileDraftToRow(draft: SecretFileDraft) {
  return {
    key: draft.key,
    type: "secret" as const,
    value: draft.scope === "static" ? draft.value : "",
    promptOnInstallation: draft.scope === "installation",
    required: draft.scope === "installation" ? draft.required : false,
    description: draft.description,
    mounted: true,
  };
}

function applySecretFileDraftToRow<TFieldValues extends FieldValues>(
  form: { setValue: UseFormSetValue<TFieldValues> },
  prefix: string,
  index: number,
  draft: SecretFileDraft,
) {
  const set = (name: string, value: unknown) =>
    form.setValue(
      `${prefix}.${index}.${name}` as FieldPath<TFieldValues>,
      value as PathValue<TFieldValues, FieldPath<TFieldValues>>,
      { shouldDirty: true },
    );
  set("key", draft.key);
  set("type", "secret");
  set("value", draft.scope === "static" ? draft.value : "");
  set("promptOnInstallation", draft.scope === "installation");
  set("required", draft.scope === "installation" ? draft.required : false);
  set("description", draft.description);
  set("mounted", true);
}

interface ExternalSecretDialogProps {
  isOpen: boolean;
  envKey: string;
  initialValue?: ExternalSecretValue;
  onConfirm: (value: ExternalSecretValue) => void;
  onClose: () => void;
}

function ExternalSecretDialog({
  isOpen,
  envKey,
  initialValue,
  onConfirm,
  onClose,
}: ExternalSecretDialogProps) {
  const [teamId, setTeamId] = useState<string | null>(
    initialValue?.teamId ?? null,
  );
  const [secretPath, setSecretPath] = useState<string | null>(
    initialValue?.secretPath ?? null,
  );
  const [secretKey, setSecretKey] = useState<string | null>(
    initialValue?.secretKey ?? null,
  );

  // Reset state when dialog opens or initialValue changes
  useEffect(() => {
    if (isOpen) {
      setTeamId(initialValue?.teamId ?? null);
      setSecretPath(initialValue?.secretPath ?? null);
      setSecretKey(initialValue?.secretKey ?? null);
    }
  }, [isOpen, initialValue]);

  // Handle dialog open/close
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };

  const handleConfirm = () => {
    onConfirm({ teamId, secretPath, secretKey });
  };

  return (
    <StandardDialog
      open={isOpen}
      onOpenChange={handleOpenChange}
      title={
        <span className="flex items-center gap-2">
          <Key className="h-5 w-5" />
          Set external secret
          {envKey ? (
            <span className="font-mono text-muted-foreground">{envKey}</span>
          ) : null}
        </span>
      }
      description="Select a secret from your team's external Vault to use for this environment variable."
      size="small"
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
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
