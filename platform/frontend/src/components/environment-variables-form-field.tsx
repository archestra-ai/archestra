"use client";

import { parseVaultReference } from "@shared";
import { CheckCircle2, Key, Loader2, Plus, Trash2 } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  Control,
  ControllerRenderProps,
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
  EnvironmentVariableDialog,
  type EnvVarDraft,
} from "@/components/environment-variable-dialog";
import { EnvironmentVariablesReadOnlyTable } from "@/components/environment-variables-read-only-table";
import {
  FieldScopeSelect,
  type FieldScopeValue,
} from "@/components/field-scope-select";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MCP_SECRET_AUTOCOMPLETE } from "@/lib/mcp/mcp-form-autocomplete";

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
  control: Control<TFieldValues>;
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
  control,
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
              onClick={() =>
                envFrom.append({ type: "secret", name: "", prefix: "" })
              }
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
            <FormDescription className="text-xs">
              Inject all keys from existing k8s Secrets or ConfigMaps as
              environment variables.
            </FormDescription>
          )}

          {envFrom.fields.map((field, index) => (
            <div key={field.id} className="border rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Select
                  value={envFrom.watch(
                    `${envFrom.fieldNamePrefix}.${index}.type`,
                  )}
                  onValueChange={(val) =>
                    envFrom.setValue(
                      `${envFrom.fieldNamePrefix}.${index}.type`,
                      val,
                      { shouldDirty: true },
                    )
                  }
                >
                  <SelectTrigger className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="secret">Secret</SelectItem>
                    <SelectItem value="configMap">ConfigMap</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => envFrom.remove(index)}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">
                    Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    placeholder="my-k8s-secret"
                    className="font-mono"
                    {...envFrom.register(
                      `${envFrom.fieldNamePrefix}.${index}.name`,
                    )}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Prefix (optional)</Label>
                  <Input
                    placeholder="e.g. MY_PREFIX_"
                    className="font-mono"
                    {...envFrom.register(
                      `${envFrom.fieldNamePrefix}.${index}.prefix`,
                    )}
                  />
                </div>
              </div>
            </div>
          ))}
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
            onClick={() =>
              (append as (value: unknown) => void)({
                key: "",
                type: "secret",
                value: "",
                promptOnInstallation: true,
                promptOnPreset: false,
                required: false,
                description: "",
                mounted: true,
              })
            }
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
              <FormDescription>
                Secrets mounted as files at /secrets/&lt;key&gt;.
              </FormDescription>
              <div className="border rounded-lg">
                <div className="grid grid-cols-[1.5fr_1.1fr_0.7fr_2fr_2.5fr_auto] gap-2 p-3 bg-muted/50 border-b">
                  <div className="text-xs font-medium">Key</div>
                  <div className="text-xs font-medium">Scope</div>
                  <div className="text-xs font-medium">Required</div>
                  <div className="text-xs font-medium">Value</div>
                  <div className="text-xs font-medium">Description</div>
                  <div className="w-9" />
                </div>
                {secretFileIndices.map((index) => {
                  const field = fields[index];
                  const promptOnInstallation = form.watch(
                    `${fieldNamePrefix}.${index}.promptOnInstallation` as FieldPath<TFieldValues>,
                  );
                  const promptOnPreset = form.watch(
                    `${fieldNamePrefix}.${index}.promptOnPreset` as FieldPath<TFieldValues>,
                  );
                  const scope: FieldScopeValue = promptOnInstallation
                    ? "installation"
                    : promptOnPreset
                      ? "preset"
                      : "static";
                  const setScope = (next: FieldScopeValue) => {
                    form.setValue(
                      `${fieldNamePrefix}.${index}.promptOnInstallation` as FieldPath<TFieldValues>,
                      (next === "installation") as PathValue<
                        TFieldValues,
                        FieldPath<TFieldValues>
                      >,
                      { shouldDirty: true },
                    );
                    form.setValue(
                      `${fieldNamePrefix}.${index}.promptOnPreset` as FieldPath<TFieldValues>,
                      (next === "preset") as PathValue<
                        TFieldValues,
                        FieldPath<TFieldValues>
                      >,
                      { shouldDirty: true },
                    );
                    if (next !== "installation") {
                      form.setValue(
                        `${fieldNamePrefix}.${index}.required` as FieldPath<TFieldValues>,
                        false as PathValue<
                          TFieldValues,
                          FieldPath<TFieldValues>
                        >,
                        { shouldDirty: true },
                      );
                    }
                  };
                  return (
                    <div
                      key={field.id}
                      className="grid grid-cols-[1.5fr_1.1fr_0.7fr_2fr_2.5fr_auto] gap-2 p-3 items-start border-b last:border-b-0"
                    >
                      <FormField
                        control={control}
                        name={
                          `${fieldNamePrefix}.${index}.key` as FieldPath<TFieldValues>
                        }
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Input
                                placeholder="TLS_CERT"
                                className="font-mono"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FieldScopeSelect
                        value={scope}
                        onChange={setScope}
                        disableInstallation={disablePromptOnInstallation}
                        disabledReason={disablePromptOnInstallationReason}
                      />
                      <FormField
                        control={control}
                        name={
                          `${fieldNamePrefix}.${index}.required` as FieldPath<TFieldValues>
                        }
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <div className="flex items-center h-10">
                                <Checkbox
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                  disabled={scope !== "installation"}
                                />
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      {(() => {
                        if (scope === "installation") {
                          return (
                            <div className="flex items-center h-10">
                              <p className="text-xs text-muted-foreground">
                                Prompted at installation
                              </p>
                            </div>
                          );
                        }

                        if (scope === "preset") {
                          return (
                            <div className="flex items-center h-10">
                              <p className="text-xs text-muted-foreground">
                                Set per preset
                              </p>
                            </div>
                          );
                        }

                        if (useExternalSecretsManager) {
                          const formValue = form.watch(
                            `${fieldNamePrefix}.${index}.value` as FieldPath<TFieldValues>,
                          ) as string | undefined;

                          return (
                            <div className="flex items-center h-10">
                              {formValue ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 px-2 text-xs font-mono text-green-600 hover:text-green-700"
                                  onClick={() =>
                                    setDialogOpenForEnvIndex(index)
                                  }
                                >
                                  <CheckCircle2 className="h-3 w-3 mr-1" />
                                  <span className="truncate max-w-[120px]">
                                    {parseVaultReference(formValue).key}
                                  </span>
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-8 text-xs"
                                  onClick={() =>
                                    setDialogOpenForEnvIndex(index)
                                  }
                                >
                                  <Key className="h-3 w-3 mr-1" />
                                  Set secret
                                </Button>
                              )}
                            </div>
                          );
                        }

                        const rowKey = form.watch(
                          `${fieldNamePrefix}.${index}.key` as FieldPath<TFieldValues>,
                        ) as string | undefined;
                        const hasStoredSecret =
                          !!rowKey &&
                          secretKeysWithStoredValue?.has(rowKey) === true;

                        return (
                          <FormField
                            control={control}
                            name={
                              `${fieldNamePrefix}.${index}.value` as FieldPath<TFieldValues>
                            }
                            render={({ field }) => (
                              <AutoResizeSecretTextarea
                                field={field}
                                placeholder={
                                  hasStoredSecret ? "••••••••" : undefined
                                }
                              />
                            )}
                          />
                        );
                      })()}
                      <FormField
                        control={control}
                        name={
                          `${fieldNamePrefix}.${index}.description` as FieldPath<TFieldValues>
                        }
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Textarea
                                placeholder="Optional description"
                                className="text-xs resize-y min-h-10"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(index)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </>
          );
        })()}
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
  const promptOnPreset = Boolean(get<boolean>("promptOnPreset"));
  return {
    key: get<string>("key") ?? "",
    type: (get<string>("type") ?? "plain_text") as EnvVarDraft["type"],
    scope: promptOnInstallation
      ? "installation"
      : promptOnPreset
        ? "preset"
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
    key: draft.key,
    type: draft.type,
    value: draft.scope === "static" ? draft.value : "",
    promptOnInstallation: draft.scope === "installation",
    promptOnPreset: draft.scope === "preset",
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
  set("promptOnPreset", draft.scope === "preset");
  set("required", draft.scope === "installation" ? draft.required : false);
  set("description", draft.description);
}

const MAX_TEXTAREA_HEIGHT = 128;

function AutoResizeSecretTextarea({
  field,
  placeholder,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: Generic field types
  field: ControllerRenderProps<any, any>;
  placeholder?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    }
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [adjustHeight]);

  return (
    <FormItem>
      <FormControl>
        <Textarea
          className="font-mono text-xs resize-none min-h-10 max-h-32 overflow-y-auto"
          rows={1}
          autoComplete={MCP_SECRET_AUTOCOMPLETE}
          placeholder={placeholder}
          {...field}
          ref={(el) => {
            textareaRef.current = el;
            if (typeof field.ref === "function") {
              field.ref(el);
            }
          }}
          onInput={adjustHeight}
        />
      </FormControl>
      <FormMessage />
    </FormItem>
  );
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
