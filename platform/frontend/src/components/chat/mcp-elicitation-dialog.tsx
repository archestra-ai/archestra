"use client";

import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

export type ChatMcpElicitationRequest = {
  id: string;
  conversationId: string;
  toolName: string;
  message: string;
  mode: "form" | "url";
  requestedSchema?: unknown;
  elicitationId?: string;
  url?: string;
};

type ElicitationAction = "accept" | "decline" | "cancel";
type ElicitationContentValue = string | number | boolean | string[];

type FieldSchema = {
  title?: string;
  description?: string;
  type?: string;
  enum?: unknown[];
  default?: unknown;
};

type ElicitationField = {
  name: string;
  label: string;
  required: boolean;
  schema: FieldSchema;
};

export function McpElicitationDialog({
  request,
  isSubmitting,
  onRespond,
}: {
  request: ChatMcpElicitationRequest | null;
  isSubmitting: boolean;
  onRespond: (response: {
    id: string;
    action: ElicitationAction;
    content?: Record<string, ElicitationContentValue>;
  }) => Promise<void>;
}) {
  const fields = useMemo(
    () => getElicitationFields(request?.requestedSchema),
    [request?.requestedSchema],
  );
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setValues(getDefaultValues(fields));
    setErrors({});
  }, [fields]);

  if (!request) {
    return null;
  }

  const submit = async () => {
    const validationErrors = validateValues(fields, values);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    await onRespond({
      id: request.id,
      action: "accept",
      content: normalizeValues(fields, values),
    });
  };

  const respondWithoutContent = async (action: "decline" | "cancel") => {
    await onRespond({ id: request.id, action });
  };

  return (
    <StandardFormDialog
      open={true}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) void respondWithoutContent("cancel");
      }}
      title="Additional Information"
      description={request.message}
      size="small"
      preventCloseOnInteractOutside
      onSubmit={submit}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => void respondWithoutContent("decline")}
          >
            <XIcon />
            Decline
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => void respondWithoutContent("cancel")}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            <CheckIcon />
            Continue
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {request.mode === "url" && isHttpUrl(request.url) ? (
          <a
            href={request.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary underline underline-offset-4"
          >
            Open request
          </a>
        ) : null}

        {fields.length === 0 ? (
          <Textarea
            value={String(values.response ?? "")}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                response: event.target.value,
              }))
            }
            placeholder="Response"
            aria-label="Response"
            className="min-h-24"
          />
        ) : (
          fields.map((field) => (
            <ElicitationFieldInput
              key={field.name}
              field={field}
              value={values[field.name]}
              error={errors[field.name]}
              onChange={(value) =>
                setValues((current) => {
                  setErrors((currentErrors) => {
                    if (!currentErrors[field.name]) {
                      return currentErrors;
                    }

                    const nextErrors = { ...currentErrors };
                    delete nextErrors[field.name];
                    return nextErrors;
                  });

                  return { ...current, [field.name]: value };
                })
              }
            />
          ))
        )}
      </div>
    </StandardFormDialog>
  );
}

function ElicitationFieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: ElicitationField;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const id = `mcp-elicitation-${field.name}`;
  const errorId = `${id}-error`;
  const enumValues = field.schema.enum?.filter(
    (item): item is string => typeof item === "string",
  );

  if (field.schema.type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={Boolean(value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <Label htmlFor={id}>{field.label}</Label>
        {error ? (
          <p id={errorId} className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>
        {field.label}
        {field.required ? <span className="text-destructive">*</span> : null}
      </Label>
      {enumValues?.length ? (
        <Select value={String(value ?? "")} onValueChange={onChange}>
          <SelectTrigger
            id={id}
            className="w-full"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {enumValues.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.schema.type === "string" && String(value ?? "").length > 120 ? (
        <Textarea
          id={id}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="min-h-24"
        />
      ) : (
        <Input
          id={id}
          type={
            field.schema.type === "number" || field.schema.type === "integer"
              ? "number"
              : "text"
          }
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
        />
      )}
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {field.schema.description ? (
        <p className="text-xs text-muted-foreground">
          {field.schema.description}
        </p>
      ) : null}
    </div>
  );
}

function validateValues(
  fields: ElicitationField[],
  values: Record<string, unknown>,
) {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    if (!field.required) {
      continue;
    }

    const value = values[field.name];
    const missing =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "");

    if (missing) {
      errors[field.name] = `${field.label} is required.`;
      continue;
    }

    if (
      (field.schema.type === "number" || field.schema.type === "integer") &&
      !Number.isFinite(Number(value))
    ) {
      errors[field.name] = `${field.label} must be a number.`;
    }
  }

  return errors;
}

function getElicitationFields(schema: unknown): ElicitationField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return [];
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];

  return Object.entries(schema.properties)
    .filter((entry): entry is [string, FieldSchema] => isRecord(entry[1]))
    .map(([name, fieldSchema]) => ({
      name,
      label: fieldSchema.title ?? titleize(name),
      required: required.includes(name),
      schema: fieldSchema,
    }));
}

function getDefaultValues(fields: ElicitationField[]) {
  if (fields.length === 0) {
    return { response: "" };
  }

  return Object.fromEntries(
    fields.map((field) => {
      if (field.schema.default !== undefined) {
        return [field.name, field.schema.default];
      }
      if (field.schema.type === "boolean") {
        return [field.name, false];
      }
      const firstEnumValue = field.schema.enum?.find(
        (item) => typeof item === "string",
      );
      return [field.name, firstEnumValue ?? ""];
    }),
  );
}

function normalizeValues(
  fields: ElicitationField[],
  values: Record<string, unknown>,
): Record<string, ElicitationContentValue> {
  if (fields.length === 0) {
    return { response: String(values.response ?? "") };
  }

  const entries: Array<[string, ElicitationContentValue]> = [];

  for (const field of fields) {
    const value = values[field.name];
    if (field.schema.type === "number" || field.schema.type === "integer") {
      if (!field.required && String(value ?? "").trim() === "") {
        continue;
      }
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) {
        continue;
      }
      entries.push([field.name, numericValue]);
      continue;
    }
    if (Array.isArray(value)) {
      entries.push([
        field.name,
        value.filter((item): item is string => typeof item === "string"),
      ]);
      continue;
    }
    if (typeof value === "boolean") {
      entries.push([field.name, value]);
      continue;
    }
    entries.push([field.name, String(value ?? "")]);
  }

  return Object.fromEntries(entries);
}

function titleize(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isHttpUrl(value: string | undefined) {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
