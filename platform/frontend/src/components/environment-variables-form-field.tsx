"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
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
  AddListItemButton,
  EmptyListState,
} from "@/components/empty-list-state";
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
import { Button } from "@/components/ui/button";
import { FormDescription } from "@/components/ui/form";
import {
  useCanAttachCredential,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";

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
  /**
   * Optional validator for a static plain-text value (e.g. an environment's
   * allowlist regex). Forwarded to the add/edit dialog to show an inline error
   * and block confirm. Returns an error message, or null when allowed.
   */
  validateValue?: (value: string) => string | null;
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

  secretKeysWithStoredValue,
  disablePromptOnInstallation = false,
  disablePromptOnInstallationReason,
  validateValue,
  envFrom,
}: EnvironmentVariablesFormFieldProps<TFieldValues>) {
  const { data: credentials = [] } = useRuntimeCredentials();
  const canAttach = useCanAttachCredential();
  const credentialBindingOptions = credentials
    .filter(
      (credential) =>
        !disablePromptOnInstallation || credential.allowOrganization,
    )
    .map((credential) => ({
      id: credential.key,
      label: credential.name,
      description: credential.description,
      icon: credential.icon,
      defaultKey: credential.kind?.startsWith("github_")
        ? "GITHUB_TOKEN"
        : credential.key.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
      allowedScopes: credential.allowOrganization
        ? ["static" as const]
        : ["installation" as const],
      canAttach: canAttach(credential.id),
    }));
  const [envVarDialog, setEnvVarDialog] = useState<
    { mode: "add" } | { mode: "edit"; index: number } | null
  >(null);
  const [envFromDialog, setEnvFromDialog] = useState<
    { mode: "add" } | { mode: "edit"; index: number } | null
  >(null);
  const [secretFileDialog, setSecretFileDialog] = useState<
    { mode: "add" } | { mode: "edit"; index: number } | null
  >(null);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {showLabel ? (
          <h3 className="font-semibold text-base">
            Environment Variables
            {labelSuffix}
          </h3>
        ) : (
          <ListHeading
            title="Variables"
            description="Set on this server directly, or prompted at installation."
          />
        )}
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

          const addVariableButton = (
            <AddListItemButton
              label="Add Variable"
              onClick={() => setEnvVarDialog({ mode: "add" })}
            />
          );
          if (envVarCount === 0) {
            return (
              <EmptyListState
                message="No environment variables yet."
                action={addVariableButton}
              />
            );
          }

          return (
            <>
              {showDescription && (
                <FormDescription className="text-xs">
                  Configure environment variables for the MCP server. Use
                  "Secret" type for sensitive values.
                </FormDescription>
              )}
              {/* TODO(e2e): existing tests in platform/e2e-tests drive the inline
                inputs (placeholder "API_KEY", inline Type Select, inline scope
                checkbox). After this refactor those interactions live in
                EnvironmentVariableDialog — tests must click "Add Variable"
                first, then operate inside the modal. */}
              <EnvironmentVariablesReadOnlyTable
                credentialLabels={Object.fromEntries(
                  credentialBindingOptions.map((option) => [
                    option.id,
                    option.label,
                  ]),
                )}
                form={form}
                fields={fields}
                rowIndexes={envVarIndexes}
                fieldNamePrefix={fieldNamePrefix}
                secretKeysWithStoredValue={secretKeysWithStoredValue}
                onEdit={(index) => setEnvVarDialog({ mode: "edit", index })}
                onDelete={(index) => remove(index)}
              />
              {addVariableButton}
            </>
          );
        })()}
      </div>

      <EnvironmentVariableDialog
        credentialBindingOptions={credentialBindingOptions}
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
        disableInstallation={disablePromptOnInstallation}
        disableInstallationReason={disablePromptOnInstallationReason}
        validateValue={validateValue}
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
        <div className="space-y-3">
          <ListHeading
            title="From Kubernetes Secrets and ConfigMaps"
            description="Inject every key of an existing Secret or ConfigMap as environment variables."
          />

          {envFrom.fields.length === 0 ? (
            <EmptyListState
              message="No sources yet."
              action={
                <AddListItemButton
                  label="Add Source"
                  onClick={() => setEnvFromDialog({ mode: "add" })}
                />
              }
            />
          ) : (
            <>
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
              <AddListItemButton
                label="Add Source"
                onClick={() => setEnvFromDialog({ mode: "add" })}
              />
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
      <div className="space-y-3">
        <ListHeading
          title="Secret files"
          description="Secrets mounted as files at /secrets/<key>."
        />
        {(() => {
          const addSecretFileButton = (
            <AddListItemButton
              label="Add Secret File"
              onClick={() => setSecretFileDialog({ mode: "add" })}
            />
          );
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
              <EmptyListState
                message="No secret files yet."
                action={addSecretFileButton}
              />
            );
          }

          return (
            <>
              <EnvironmentVariablesReadOnlyTable
                credentialLabels={Object.fromEntries(
                  credentialBindingOptions.map((option) => [
                    option.id,
                    option.label,
                  ]),
                )}
                form={form}
                fields={fields}
                rowIndexes={secretFileIndices}
                fieldNamePrefix={fieldNamePrefix}
                secretKeysWithStoredValue={secretKeysWithStoredValue}
                showType={false}
                keyLabel="File"
                removeAriaLabel="Remove secret file"
                onEdit={(index) => setSecretFileDialog({ mode: "edit", index })}
                onDelete={(index) => remove(index)}
              />
              {addSecretFileButton}
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
    credentialId: get<string | undefined>("credentialId"),
    key: get<string>("key") ?? "",
    type: (get<string>("type") ?? "plain_text") as EnvVarDraft["type"],
    scope:
      get<string>("credentialScope") === "personal" || promptOnInstallation
        ? "installation"
        : "static",
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
    credentialId: draft.credentialId,
    credentialScope: draft.credentialId
      ? draft.scope === "installation"
        ? "personal"
        : "organization"
      : undefined,
    key: draft.key,
    type: draft.type,
    value: draft.scope === "static" ? draft.value : "",
    promptOnInstallation: !draft.credentialId && draft.scope === "installation",
    required:
      draft.scope === "installation" || draft.credentialId
        ? draft.required
        : false,
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
  set("credentialId", draft.credentialId);
  set(
    "credentialScope",
    draft.credentialId
      ? draft.scope === "installation"
        ? "personal"
        : "organization"
      : undefined,
  );
  set("key", draft.key);
  set("type", draft.type);
  set("value", draft.scope === "static" ? draft.value : "");
  set(
    "promptOnInstallation",
    !draft.credentialId && draft.scope === "installation",
  );
  set(
    "required",
    draft.scope === "installation" || draft.credentialId
      ? draft.required
      : false,
  );
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

function ListHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-0.5">
      <h4 className="text-sm font-medium">{title}</h4>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
