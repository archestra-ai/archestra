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
    content?: Record<string, unknown>;
  }) => Promise<void>;
}) {
  const fields = useMemo(
    () => getElicitationFields(request?.requestedSchema),
    [request?.requestedSchema],
  );
  const [values, setValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    setValues(getDefaultValues(fields));
  }, [fields]);

  if (!request) {
    return null;
  }

  const submit = async () => {
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
        {request.mode === "url" && request.url ? (
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
            className="min-h-24"
          />
        ) : (
          fields.map((field) => (
            <ElicitationFieldInput
              key={field.name}
              field={field}
              value={values[field.name]}
              onChange={(value) =>
                setValues((current) => ({ ...current, [field.name]: value }))
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
  onChange,
}: {
  field: ElicitationField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `mcp-elicitation-${field.name}`;
  const enumValues = field.schema.enum?.filter(
    (item): item is string => typeof item === "string",
  );

  if (field.schema.type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <Label htmlFor={id}>{field.label}</Label>
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
          <SelectTrigger id={id} className="w-full">
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
        />
      )}
      {field.schema.description ? (
        <p className="text-xs text-muted-foreground">
          {field.schema.description}
        </p>
      ) : null}
    </div>
  );
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
) {
  if (fields.length === 0) {
    return values;
  }

  return Object.fromEntries(
    fields.map((field) => {
      const value = values[field.name];
      if (field.schema.type === "number" || field.schema.type === "integer") {
        const numericValue = Number(value);
        return [
          field.name,
          Number.isFinite(numericValue) ? numericValue : undefined,
        ];
      }
      return [field.name, value];
    }),
  );
}

function titleize(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
