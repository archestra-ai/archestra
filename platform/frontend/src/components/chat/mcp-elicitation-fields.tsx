"use client";

import { z } from "zod";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * One question the backend is waiting on, as streamed in a
 * `data-mcp-elicitation` chunk. `toolCallId` names the tool call that raised
 * it (when known) and `header` is the short tab label `ask_user` may send.
 */
export const ChatMcpElicitationRequestSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  toolName: z.string().min(1),
  message: z.string(),
  mode: z.enum(["form", "url"]),
  requestedSchema: z.unknown().optional(),
  elicitationId: z.string().optional(),
  url: z.string().optional(),
  toolCallId: z.string().optional(),
  header: z.string().optional(),
});

export type ChatMcpElicitationRequest = z.infer<
  typeof ChatMcpElicitationRequestSchema
>;

type ElicitationContentValue = string | number | boolean | string[];

export type ElicitationResponse = {
  id: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, ElicitationContentValue>;
};

export type ElicitationField = {
  name: string;
  label: string;
  required: boolean;
  schema: FieldSchema;
};

/**
 * A request every field of which is a pick (an enum or a boolean): the
 * multiple-choice questions `ask_user` sends. Those render inline in the chat
 * as a card; anything else gets the modal form.
 */
export function isChoiceElicitationRequest(request: ChatMcpElicitationRequest) {
  return isChoiceForm(getElicitationFields(request.requestedSchema));
}

export function getElicitationFields(schema: unknown): ElicitationField[] {
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

function isChoiceForm(fields: ElicitationField[]) {
  return (
    fields.length > 0 &&
    fields.every((field) => {
      const options = field.schema.enum;
      return (
        field.schema.type === "boolean" ||
        (!!options?.length &&
          options.every((option) => typeof option === "string"))
      );
    })
  );
}

/** One enum field: picking an option answers the whole question. */
export function isSingleChoiceForm(fields: ElicitationField[]) {
  return (
    fields.length === 1 &&
    fields[0].schema.type !== "boolean" &&
    (fields[0].schema.enum?.length ?? 0) > 0
  );
}

export function getDefaultValues(fields: ElicitationField[]) {
  if (fields.length === 0) {
    return { response: "" };
  }

  const choiceForm = isChoiceForm(fields);
  return Object.fromEntries(
    fields.map((field) => {
      if (field.schema.default !== undefined) {
        return [field.name, field.schema.default];
      }
      if (field.schema.type === "boolean") {
        return [field.name, false];
      }
      if (!choiceForm) {
        const firstEnumValue = field.schema.enum?.find(
          (item) => typeof item === "string" || typeof item === "number",
        );
        if (firstEnumValue !== undefined) {
          return [field.name, String(firstEnumValue)];
        }
      }
      return [field.name, ""];
    }),
  );
}

export function validateValues(
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

/**
 * Whether a choice form is complete enough to submit. Required fields must
 * have a value; an all-optional form is complete even with nothing checked.
 */
export function hasChoiceSelection(
  fields: ElicitationField[],
  values: Record<string, unknown>,
) {
  return Object.keys(validateValues(fields, values)).length === 0;
}

export function normalizeValues(
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

export function ElicitationFieldInput({
  idPrefix,
  field,
  choiceStyle,
  hideLabel = false,
  labelledBy,
  value,
  error,
  disabled = false,
  onChange,
  onPick,
}: {
  /** Keeps control ids unique when several requests render at once. */
  idPrefix: string;
  field: ElicitationField;
  choiceStyle: boolean;
  hideLabel?: boolean;
  /**
   * Id of the element that names this field's options — the question itself
   * when it has a single field — instead of the field's schema title.
   */
  labelledBy?: string;
  value: unknown;
  error?: string;
  disabled?: boolean;
  onChange: (value: unknown) => void;
  /**
   * Called on every click of an option, including the one already picked,
   * which changes nothing and so never reaches `onChange`.
   */
  onPick?: (value: string) => void;
}) {
  const id = `mcp-elicitation-${idPrefix}-${field.name}`;
  const errorId = `${id}-error`;
  const labelId = `${id}-label`;
  const enumValues = field.schema.enum?.flatMap((item) =>
    typeof item === "string" || typeof item === "number" ? [String(item)] : [],
  );
  const enumDescriptions = field.schema.enumDescriptions;

  if (field.schema.type === "boolean") {
    if (choiceStyle) {
      return (
        <OptionRow
          htmlFor={id}
          selected={value === true}
          error={Boolean(error)}
        >
          <Checkbox
            id={id}
            checked={Boolean(value)}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            onCheckedChange={(checked) => onChange(checked === true)}
            className="mt-0.5"
          />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm leading-5">{field.label}</span>
            {field.schema.description ? (
              <FieldDescription>{field.schema.description}</FieldDescription>
            ) : null}
          </div>
        </OptionRow>
      );
    }
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={Boolean(value)}
          disabled={disabled}
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

  if (enumValues?.length && choiceStyle) {
    return (
      <div className="flex flex-col gap-1.5">
        {hideLabel ? null : (
          <p id={labelId} className="text-sm font-medium">
            {field.label}
            {field.required ? (
              <span className="text-destructive">*</span>
            ) : null}
          </p>
        )}
        <RadioGroup
          value={String(value ?? "")}
          disabled={disabled}
          onValueChange={onChange}
          aria-labelledby={labelledBy ?? (hideLabel ? undefined : labelId)}
          aria-label={!labelledBy && hideLabel ? field.label : undefined}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="flex flex-col gap-1.5"
        >
          {enumValues.map((option, index) => {
            const optionId = `${id}-${index}`;
            const description =
              typeof enumDescriptions?.[index] === "string" &&
              enumDescriptions[index].length > 0
                ? enumDescriptions[index]
                : undefined;
            return (
              <OptionRow
                key={option}
                htmlFor={optionId}
                selected={value === option}
                error={Boolean(error)}
              >
                <RadioGroupItem
                  id={optionId}
                  value={option}
                  onClick={() => onPick?.(option)}
                  className="mt-0.5"
                />
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm leading-5">{option}</span>
                  {description ? (
                    <FieldDescription>{description}</FieldDescription>
                  ) : null}
                </div>
              </OptionRow>
            );
          })}
        </RadioGroup>
        {error ? (
          <p id={errorId} className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {field.schema.description ? (
          <FieldDescription>{field.schema.description}</FieldDescription>
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
            disabled={disabled}
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
          disabled={disabled}
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
          disabled={disabled}
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
        <FieldDescription>{field.schema.description}</FieldDescription>
      ) : null}
    </div>
  );
}

// === Internal helpers ===

type FieldSchema = {
  title?: string;
  description?: string;
  type?: string;
  enum?: unknown[];
  enumDescriptions?: unknown[];
  default?: unknown;
};

/**
 * One pickable option. The whole row is the control's label, so a click
 * anywhere on the row picks it. Selected and hover states share the muted
 * background; the border only shows once the row is picked.
 */
function OptionRow({
  htmlFor,
  selected,
  error,
  children,
}: {
  htmlFor: string;
  selected: boolean;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        "-mx-1 flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors",
        "hover:bg-muted/60 has-[:focus-visible]:bg-muted/60 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring/50",
        selected ? "border-border bg-muted" : "border-transparent",
        error && !selected ? "border-destructive/40" : null,
      )}
    >
      {children}
    </label>
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
