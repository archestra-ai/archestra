"use client";

import { E2eTestId, parseVaultReference } from "@shared";
import { CheckCircle2, Key, Loader2, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type {
  Control,
  FieldArrayWithId,
  FieldPath,
  FieldValues,
  PathValue,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  MCP_CONFIG_AUTOCOMPLETE,
  MCP_SECRET_AUTOCOMPLETE,
} from "@/lib/mcp/mcp-form-autocomplete";

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

interface InstallConfigFieldsTableProps<TFieldValues extends FieldValues> {
  control: Control<TFieldValues>;
  form: {
    watch: UseFormWatch<TFieldValues>;
    setValue: UseFormSetValue<TFieldValues>;
  };
  // biome-ignore lint/suspicious/noExplicitAny: field arrays require generic any support
  fields: FieldArrayWithId<TFieldValues, any, "id">[];
  rowIndexes?: number[];
  remove: (index: number) => void;
  fieldNamePrefix: string;
  keyFieldName?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  typeFieldName?: string | null;
  valueFieldName?: string;
  promptFieldName?: string;
  requiredFieldName?: string;
  descriptionFieldName?: string;
  valuePlaceholder?: string;
  useExternalSecretsManager?: boolean;
  bearerPrefixFieldName?: string | null;
  disablePromptOnInstallation?: boolean;
  disablePromptOnInstallationReason?: string;
}

export function InstallConfigFieldsTable<TFieldValues extends FieldValues>({
  control,
  form,
  fields,
  rowIndexes,
  remove,
  fieldNamePrefix,
  keyFieldName = "key",
  keyLabel = "Key",
  keyPlaceholder = "API_KEY",
  typeFieldName = "type",
  valueFieldName = "value",
  promptFieldName = "promptOnInstallation",
  requiredFieldName = "required",
  descriptionFieldName = "description",
  valuePlaceholder = "your-value",
  useExternalSecretsManager = false,
  bearerPrefixFieldName = null,
  disablePromptOnInstallation = false,
  disablePromptOnInstallationReason,
}: InstallConfigFieldsTableProps<TFieldValues>) {
  const showTypeColumn = typeFieldName !== null;
  const showBearerColumn = bearerPrefixFieldName !== null;
  const gridClass = showTypeColumn
    ? showBearerColumn
      ? "grid grid-cols-[1.5fr_1.2fr_0.7fr_0.7fr_0.6fr_1.5fr_2.5fr_auto] gap-2"
      : "grid grid-cols-[1.5fr_1.2fr_0.7fr_0.7fr_1.5fr_2.5fr_auto] gap-2"
    : showBearerColumn
      ? "grid grid-cols-[1.5fr_0.7fr_0.7fr_0.6fr_1.5fr_2.5fr_auto] gap-2"
      : "grid grid-cols-[1.5fr_0.7fr_0.7fr_1.5fr_2.5fr_auto] gap-2";
  const indexes = rowIndexes ?? fields.map((_, index) => index);

  const [dialogOpenForIndex, setDialogOpenForIndex] = useState<number | null>(
    null,
  );

  const dialogKey =
    dialogOpenForIndex !== null
      ? form.watch(
          `${fieldNamePrefix}.${dialogOpenForIndex}.${keyFieldName}` as FieldPath<TFieldValues>,
        )
      : "";

  const handleSecretConfirm = (index: number, value: ExternalSecretValue) => {
    if (value.secretPath && value.secretKey) {
      form.setValue(
        `${fieldNamePrefix}.${index}.${valueFieldName}` as FieldPath<TFieldValues>,
        `${value.secretPath}#${value.secretKey}` as PathValue<
          TFieldValues,
          FieldPath<TFieldValues>
        >,
      );
    }
    setDialogOpenForIndex(null);
  };

  if (indexes.length === 0) {
    return null;
  }

  return (
    <>
      <div className="border rounded-lg">
        <div className={`${gridClass} p-3 bg-muted/50 border-b`}>
          <div className="text-xs font-medium">{keyLabel}</div>
          {showTypeColumn && <div className="text-xs font-medium">Type</div>}
          <div className="text-xs font-medium">Prompt user</div>
          <div className="text-xs font-medium">Required</div>
          {showBearerColumn && (
            <div className="text-xs font-medium">Bearer</div>
          )}
          <div className="text-xs font-medium">Value</div>
          <div className="text-xs font-medium">Description</div>
          <div className="w-9" />
        </div>
        {indexes.map((index) => {
          const field = fields[index];
          const promptOnInstallation = form.watch(
            `${fieldNamePrefix}.${index}.${promptFieldName}` as FieldPath<TFieldValues>,
          );
          const valueType: string = showTypeColumn
            ? form.watch(
                `${fieldNamePrefix}.${index}.${typeFieldName}` as FieldPath<TFieldValues>,
              )
            : "plain_text";

          return (
            <div
              key={field.id}
              className={`${gridClass} p-3 items-start border-b last:border-b-0`}
            >
              <FormField
                control={control}
                name={
                  `${fieldNamePrefix}.${index}.${keyFieldName}` as FieldPath<TFieldValues>
                }
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input
                        placeholder={keyPlaceholder}
                        className="font-mono"
                        autoComplete={MCP_CONFIG_AUTOCOMPLETE}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {showTypeColumn && (
                <FormField
                  control={control}
                  name={
                    `${fieldNamePrefix}.${index}.${typeFieldName}` as FieldPath<TFieldValues>
                  }
                  render={({ field }) => (
                    <FormItem>
                      <Select
                        onValueChange={(newType) => {
                          field.onChange(newType);
                          form.setValue(
                            `${fieldNamePrefix}.${index}.${valueFieldName}` as FieldPath<TFieldValues>,
                            "" as PathValue<
                              TFieldValues,
                              FieldPath<TFieldValues>
                            >,
                          );
                        }}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger
                            data-testid={
                              E2eTestId.SelectEnvironmentVariableType
                            }
                          >
                            <SelectValue placeholder="Type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="plain_text">Plain text</SelectItem>
                          <SelectItem value="secret">Secret</SelectItem>
                          <SelectItem value="boolean">Boolean</SelectItem>
                          <SelectItem value="number">Number</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={control}
                name={
                  `${fieldNamePrefix}.${index}.${promptFieldName}` as FieldPath<TFieldValues>
                }
                render={({ field }) => {
                  const checkbox = (
                    <Checkbox
                      data-testid={E2eTestId.PromptOnInstallationCheckbox}
                      checked={field.value}
                      disabled={disablePromptOnInstallation}
                      onCheckedChange={(checked) => {
                        field.onChange(checked);
                        if (!checked) {
                          form.setValue(
                            `${fieldNamePrefix}.${index}.${requiredFieldName}` as FieldPath<TFieldValues>,
                            false as PathValue<
                              TFieldValues,
                              FieldPath<TFieldValues>
                            >,
                          );
                        }
                      }}
                    />
                  );
                  return (
                    <FormItem>
                      <FormControl>
                        <div className="flex items-center h-10">
                          {disablePromptOnInstallation &&
                          disablePromptOnInstallationReason ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  // biome-ignore lint/a11y/noNoninteractiveTabindex: tabIndex needed so tooltip trigger receives keyboard focus when wrapping a disabled control
                                  tabIndex={0}
                                  className="cursor-not-allowed"
                                >
                                  {checkbox}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="max-w-xs">
                                  {disablePromptOnInstallationReason}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            checkbox
                          )}
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />

              <FormField
                control={control}
                name={
                  `${fieldNamePrefix}.${index}.${requiredFieldName}` as FieldPath<TFieldValues>
                }
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <div className="flex items-center h-10">
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={!promptOnInstallation}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {showBearerColumn && (
                <FormField
                  control={control}
                  name={
                    `${fieldNamePrefix}.${index}.${bearerPrefixFieldName}` as FieldPath<TFieldValues>
                  }
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <div className="flex items-center h-10">
                          <Checkbox
                            checked={Boolean(field.value)}
                            onCheckedChange={(checked) =>
                              field.onChange(Boolean(checked))
                            }
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {promptOnInstallation ? (
                <div className="flex items-center h-10">
                  <p className="text-xs text-muted-foreground">
                    Prompted at installation
                  </p>
                </div>
              ) : useExternalSecretsManager && valueType === "secret" ? (
                <div className="flex items-center h-10">
                  {(() => {
                    const formValue = form.watch(
                      `${fieldNamePrefix}.${index}.${valueFieldName}` as FieldPath<TFieldValues>,
                    ) as string | undefined;

                    if (formValue) {
                      return (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs font-mono text-green-600 hover:text-green-700"
                          onClick={() => setDialogOpenForIndex(index)}
                        >
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          <span className="truncate max-w-[120px]">
                            {parseVaultReference(formValue).key}
                          </span>
                        </Button>
                      );
                    }

                    return (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setDialogOpenForIndex(index)}
                      >
                        <Key className="h-3 w-3 mr-1" />
                        Set secret
                      </Button>
                    );
                  })()}
                </div>
              ) : (
                <FormField
                  control={control}
                  name={
                    `${fieldNamePrefix}.${index}.${valueFieldName}` as FieldPath<TFieldValues>
                  }
                  render={({ field }) => {
                    if (valueType === "boolean") {
                      const normalizedValue =
                        field.value === "true" ? "true" : "false";
                      if (field.value !== normalizedValue) {
                        field.onChange(normalizedValue);
                      }

                      return (
                        <FormItem>
                          <FormControl>
                            <div className="flex items-center h-10">
                              <Checkbox
                                checked={normalizedValue === "true"}
                                onCheckedChange={(checked) =>
                                  field.onChange(checked ? "true" : "false")
                                }
                              />
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      );
                    }

                    if (valueType === "number") {
                      return (
                        <FormItem>
                          <FormControl>
                            <Input
                              type="number"
                              placeholder="0"
                              className="font-mono"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      );
                    }

                    return (
                      <FormItem>
                        <FormControl>
                          <Input
                            type={valueType === "secret" ? "password" : "text"}
                            placeholder={valuePlaceholder}
                            className="font-mono"
                            autoComplete={
                              valueType === "secret"
                                ? MCP_SECRET_AUTOCOMPLETE
                                : MCP_CONFIG_AUTOCOMPLETE
                            }
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />
              )}

              <FormField
                control={control}
                name={
                  `${fieldNamePrefix}.${index}.${descriptionFieldName}` as FieldPath<TFieldValues>
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

      {useExternalSecretsManager && dialogOpenForIndex !== null && (
        <ExternalSecretDialog
          isOpen={dialogOpenForIndex !== null}
          envKey={dialogKey || "field"}
          onClose={() => setDialogOpenForIndex(null)}
          onConfirm={(value) => handleSecretConfirm(dialogOpenForIndex, value)}
        />
      )}
    </>
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

  useEffect(() => {
    if (isOpen) {
      setTeamId(initialValue?.teamId ?? null);
      setSecretPath(initialValue?.secretPath ?? null);
      setSecretKey(initialValue?.secretKey ?? null);
    }
  }, [isOpen, initialValue]);

  const handleConfirm = () => {
    onConfirm({ teamId, secretPath, secretKey });
  };

  return (
    <StandardDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        <span className="flex items-center gap-2">
          <Key className="h-5 w-5" />
          Set external secret
          <span className="font-mono text-muted-foreground">{envKey}</span>
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
