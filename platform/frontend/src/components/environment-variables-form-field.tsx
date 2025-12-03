"use client";

import { Plus, Trash2 } from "lucide-react";
import type {
  Control,
  FieldArrayWithId,
  FieldPath,
  FieldValues,
  UseFieldArrayAppend,
  UseFieldArrayRemove,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

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
}: EnvironmentVariablesFormFieldProps<TFieldValues>) {
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
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
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
                {!promptOnInstallation ? (
                  <FormField
                    control={control}
                    name={
                      `${fieldNamePrefix}.${index}.value` as FieldPath<TFieldValues>
                    }
                    render={({ field }) => {
                      const envType = form.watch(
                        `${fieldNamePrefix}.${index}.type` as FieldPath<TFieldValues>,
                      );

                      // Boolean type: render checkbox with label
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
                              <div className="flex items-center gap-2 h-10">
                                <Checkbox
                                  checked={normalizedValue === "true"}
                                  onCheckedChange={(checked) =>
                                    field.onChange(checked ? "true" : "false")
                                  }
                                />
                                <span className="text-sm">
                                  {normalizedValue === "true"
                                    ? "True"
                                    : "False"}
                                </span>
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
                              type={envType === "secret" ? "password" : "text"}
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
                ) : (
                  <div className="flex items-center h-10">
                    <p className="text-xs text-muted-foreground">
                      Prompted at installation
                    </p>
                  </div>
                )}
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
    </div>
  );
}
