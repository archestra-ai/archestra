"use client";

import { E2eTestId, parseVaultReference } from "@shared";
import { CheckCircle2, Key, Plus, Trash2 } from "lucide-react";
import { lazy, useEffect, useState } from "react";
import type {
  Control,
  FieldArrayWithId,
  FieldPath,
  FieldValues,
  PathValue,
  UseFieldArrayAppend,
  UseFieldArrayRemove,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
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
  /** When true, non-prompted secret values will be sourced from external secrets manager (Vault) */
  useExternalSecretsManager?: boolean;
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
  useExternalSecretsManager = false,
}: EnvironmentVariablesFormFieldProps<TFieldValues>) {
  // State for external secret dialog
  const [dialogOpenForEnvIndex, setDialogOpenForEnvIndex] = useState<
    number | null
  >(null);

  const handleSecretConfirm = (index: number, value: ExternalSecretValue) => {
    // Store the value in the form field as path#key format
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

  // Get the env key for the dialog title
  const dialogEnvKey =
    dialogOpenForEnvIndex !== null
      ? form.watch(
          `${fieldNamePrefix}.${dialogOpenForEnvIndex}.key` as FieldPath<TFieldValues>,
        )
      : "";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        {showLabel && <FormLabel>Environment Variables</FormLabel>}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            (append as (value: unknown) => void)({
              key: "",
              type: "plain_text",
              value: "",
              promptOnInstallation: false,
              required: false,
              description: "",
            })
          }
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Variable
        </Button>
      </div>
      {showDescription && (
        <FormDescription>
          Configure environment variables for the MCP server. Use "Secret" type
          for sensitive values.
        </FormDescription>
      )}
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No environment variables configured.
        </p>
      ) : (
        <div className="border rounded-lg">
          <div className="grid grid-cols-[1.5fr_1.2fr_0.7fr_0.7fr_1.5fr_2.5fr_auto] gap-2 p-3 bg-muted/50 border-b">
            <div className="text-xs font-medium">Key</div>
            <div className="text-xs font-medium">Type</div>
            <div className="text-xs font-medium">
              Prompt on each installation
            </div>
            <div className="text-xs font-medium">Required</div>
            <div className="text-xs font-medium">Value</div>
            <div className="text-xs font-medium">Description</div>
            <div className="w-9" />
          </div>
          {fields.map((field, index) => {
            const promptOnInstallation = form.watch(
              `${fieldNamePrefix}.${index}.promptOnInstallation` as FieldPath<TFieldValues>,
            );
            return (
              <div
                key={field.id}
                className="grid grid-cols-[1.5fr_1.2fr_0.7fr_0.7fr_1.5fr_2.5fr_auto] gap-2 p-3 items-start border-b last:border-b-0"
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
                          placeholder="API_KEY"
                          className="font-mono"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={control}
                  name={
                    `${fieldNamePrefix}.${index}.type` as FieldPath<TFieldValues>
                  }
                  render={({ field }) => (
                    <FormItem>
                      <Select
                        onValueChange={(newType) => {
                          field.onChange(newType);
                          // Clear value when type changes
                          form.setValue(
                            `${fieldNamePrefix}.${index}.value` as FieldPath<TFieldValues>,
                            // biome-ignore lint/suspicious/noExplicitAny: Generic field types require any for setValue
                            "" as any,
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
                <FormField
                  control={control}
                  name={
                    `${fieldNamePrefix}.${index}.promptOnInstallation` as FieldPath<TFieldValues>
                  }
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <div className="flex items-center h-10">
                          <Checkbox
                            data-testid={E2eTestId.PromptOnInstallationCheckbox}
                            checked={field.value}
                            onCheckedChange={(checked) => {
                              field.onChange(checked);
                              // When unchecking "Prompt on installation", also uncheck "Required"
                              if (!checked) {
                                form.setValue(
                                  `${fieldNamePrefix}.${index}.required` as FieldPath<TFieldValues>,
                                  // biome-ignore lint/suspicious/noExplicitAny: Generic field types require any for setValue
                                  false as any,
                                );
                              }
                            }}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
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
                            disabled={!promptOnInstallation}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {(() => {
                  const envType = form.watch(
                    `${fieldNamePrefix}.${index}.type` as FieldPath<TFieldValues>,
                  );

                  // If prompted at installation, show placeholder text
                  if (promptOnInstallation) {
                    return (
                      <div className="flex items-center h-10">
                        <p className="text-xs text-muted-foreground">
                          Prompted at installation
                        </p>
                      </div>
                    );
                  }

                  // If using external secrets manager and this is a secret type, show Set secret button
                  if (useExternalSecretsManager && envType === "secret") {
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
                            onClick={() => setDialogOpenForEnvIndex(index)}
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
                            onClick={() => setDialogOpenForEnvIndex(index)}
                          >
                            <Key className="h-3 w-3 mr-1" />
                            Set secret
                          </Button>
                        )}
                      </div>
                    );
                  }

                  // Otherwise show the value input
                  return (
                    <FormField
                      control={control}
                      name={
                        `${fieldNamePrefix}.${index}.value` as FieldPath<TFieldValues>
                      }
                      render={({ field }) => {
                        // Boolean type: render checkbox
                        if (envType === "boolean") {
                          // Normalize empty/undefined values to "false"
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

                        // Number type: render number input
                        if (envType === "number") {
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

                        // String/Secret types: render input
                        return (
                          <FormItem>
                            <FormControl>
                              <Input
                                type={
                                  envType === "secret" ? "password" : "text"
                                }
                                placeholder="your-value"
                                className="font-mono"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        );
                      }}
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
      )}

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
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Set external secret
            {envKey && (
              <span className="font-mono text-muted-foreground">{envKey}</span>
            )}
          </DialogTitle>
          <DialogDescription>
            Select a secret from your team's external Vault to use for this
            environment variable.
          </DialogDescription>
        </DialogHeader>

        <ExternalSecretSelector
          selectedTeamId={teamId}
          selectedSecretPath={secretPath}
          selectedSecretKey={secretKey}
          onTeamChange={setTeamId}
          onSecretChange={setSecretPath}
          onSecretKeyChange={setSecretKey}
        />

        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
