"use client";

import { ASK_USER_OTHER_ANSWER_FIELD } from "@archestra/shared";
import { ArrowRightIcon, PencilIcon } from "lucide-react";
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
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

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
  /**
   * Set by the platform for built-in requests with custom controls.
   * `openappa_review` prompts the user to review a blocked tool call.
   * Third-party MCP server requests never include this kind.
   */
  kind: z.literal("openappa_review").optional(),
  /** Reviewed call's tool name, when the platform loaded an offer review. */
  reviewedTool: z.string().optional(),
  /** Reviewed call's arguments as JSON text. */
  reviewedArguments: z.string().optional(),
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
 * A request where every field is a choice (enum or boolean).
 * Multiple-choice questions render inline as a card in Chat.
 * Other requests open the modal dialog form.
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

/**
 * `ask_user`'s "Type something" field: a typed answer instead of a pick. Only the
 * property it names counts; another server's optional text field is its own
 * question, and its form keeps the dialog.
 */
export function isOtherTextField(field: ElicitationField) {
  return (
    field.name === ASK_USER_OTHER_ANSWER_FIELD &&
    field.schema.type === "string" &&
    !field.schema.enum?.length &&
    !field.required
  );
}

function isChoiceForm(fields: ElicitationField[]) {
  const choices = fields.filter(isChoiceField);
  return (
    choices.length > 0 &&
    fields.length - choices.length <= 1 &&
    fields.every((field) => isChoiceField(field) || isOtherTextField(field))
  );
}

/** One enum field: picking an option answers the whole question. */
export function isSingleChoiceForm(fields: ElicitationField[]) {
  const choices = fields.filter((field) => !isOtherTextField(field));
  return (
    choices.length === 1 &&
    choices[0].schema.type !== "boolean" &&
    (choices[0].schema.enum?.length ?? 0) > 0
  );
}

/**
 * The answer a chat message gives the open question. With one question
 * waiting, and it a single pick that takes a typed answer, the composer is
 * that typed answer: the card shows no text box of its own.
 */
export function getComposerAnswer({
  requests,
  text,
}: {
  requests: ChatMcpElicitationRequest[];
  text: string;
}): ElicitationResponse | null {
  const typed = text.trim();
  if (!typed || !takesComposerAnswer(requests)) {
    return null;
  }
  const [request] = requests;
  const fields = getElicitationFields(request.requestedSchema);
  const other = fields.find(isOtherTextField);
  if (!other) {
    return null;
  }
  return {
    id: request.id,
    action: "accept",
    content: normalizeValues(fields, {
      ...Object.fromEntries(fields.map((field) => [field.name, ""])),
      [other.name]: typed,
    }),
  };
}

/** Whether the chat composer takes the open question's typed answer (see `getComposerAnswer`). */
export function takesComposerAnswer(
  requests: ChatMcpElicitationRequest[],
): boolean {
  if (requests.length !== 1) {
    return false;
  }
  const fields = getElicitationFields(requests[0].requestedSchema);
  return fields.some(isOtherTextField) && isSingleChoiceForm(fields);
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
 * Checks whether a choice form has required selections before submitting.
 * Required fields must have a value. An all-optional form is complete even with
 * nothing selected, unless it offers "Type something": then it needs a pick or text.
 */
export function hasChoiceSelection(
  fields: ElicitationField[],
  values: Record<string, unknown>,
) {
  if (Object.keys(validateValues(fields, values)).length > 0) return false;
  // With an "Type something" field, a pick or a typed answer is what answers it.
  return (
    !fields.some(isOtherTextField) ||
    fields.some((field) => {
      const value = values[field.name];
      return field.schema.type === "boolean"
        ? value === true
        : typeof value === "string" && value.trim() !== "";
    })
  );
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
  onFocus,
  other,
  submitsOnPick = false,
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
  /** Focus on a text field; choice controls ignore it. */
  onFocus?: () => void;
  /** Adds an "Type something" option to a single pick, for a typed answer instead. */
  other?: { selected: boolean; onSelect: () => void };
  /**
   * Options are buttons that answer on activation, not radios that only
   * select: a radio promises a pick that something else submits.
   */
  submitsOnPick?: boolean;
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

  if (enumValues?.length && choiceStyle && submitsOnPick) {
    return (
      <fieldset
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : field.label}
        className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
      >
        {enumValues.map((option, index) => {
          const description =
            typeof enumDescriptions?.[index] === "string" &&
            enumDescriptions[index].length > 0
              ? enumDescriptions[index]
              : undefined;
          return (
            <OptionButton
              key={option}
              selected={value === option}
              disabled={disabled}
              onClick={() => {
                onChange(option);
                onPick?.(option);
              }}
            >
              <span className="text-sm font-medium leading-5">{option}</span>
              {description ? (
                <FieldDescription className="group-hover:text-primary-foreground/80 group-focus-visible:text-primary-foreground/80">
                  {description}
                </FieldDescription>
              ) : null}
            </OptionButton>
          );
        })}
        {other ? (
          <OptionButton
            selected={other.selected}
            aria-expanded={other.selected}
            disabled={disabled}
            onClick={other.onSelect}
            icon={<PencilIcon className="size-4" aria-hidden />}
          >
            <span className="text-sm leading-5">Type something…</span>
          </OptionButton>
        ) : null}
      </fieldset>
    );
  }

  if (enumValues?.length && choiceStyle) {
    return (
      <div className="flex flex-col gap-1">
        {hideLabel ? null : (
          <p id={labelId} className="text-sm font-medium">
            {field.label}
            {field.required ? (
              <span className="text-destructive">*</span>
            ) : null}
          </p>
        )}
        <RadioGroup
          value={other?.selected ? OTHER_OPTION_VALUE : String(value ?? "")}
          disabled={disabled}
          onValueChange={(picked) =>
            picked === OTHER_OPTION_VALUE ? other?.onSelect() : onChange(picked)
          }
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
          {other ? (
            <OptionRow
              htmlFor={`${id}-other`}
              selected={other.selected}
              error={Boolean(error)}
            >
              <RadioGroupItem
                id={`${id}-other`}
                value={OTHER_OPTION_VALUE}
                className="mt-0.5"
              />
              <span className="text-sm leading-5">Type something</span>
            </OptionRow>
          ) : null}
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
      <Label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
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
      ) : field.schema.type === "string" ? (
        <Textarea
          id={id}
          value={String(value ?? "")}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onFocus={onFocus}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className={String(value ?? "").length > 120 ? "min-h-24" : "min-h-10"}
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

const OTHER_OPTION_VALUE = ASK_USER_OTHER_ANSWER_FIELD;

function isChoiceField(field: ElicitationField) {
  const options = field.schema.enum;
  return (
    field.schema.type === "boolean" ||
    (!!options?.length && options.every((option) => typeof option === "string"))
  );
}

type FieldSchema = {
  title?: string;
  description?: string;
  type?: string;
  enum?: unknown[];
  enumDescriptions?: unknown[];
  default?: unknown;
};

/**
 * An option that answers when pressed. A bordered tile that fills with the
 * primary color on hover, with an arrow, so it reads as an action rather
 * than a pick that something else submits. With `icon` it opens a typed
 * answer instead: a quieter tile with the icon in front and no arrow.
 */
function OptionButton({
  selected = false,
  icon,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  selected?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <UnstyledButton
      className={cn(
        "group flex min-h-11 w-full items-center gap-3 rounded-md border bg-card px-3 py-2 text-left shadow-xs transition-colors outline-none",
        "hover:border-primary hover:bg-primary hover:text-primary-foreground",
        "focus-visible:border-primary focus-visible:bg-primary focus-visible:text-primary-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        icon ? "text-muted-foreground" : null,
        selected ? "border-primary" : "border-border",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">{children}</span>
      {icon ? null : (
        <ArrowRightIcon
          className="size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden
        />
      )}
    </UnstyledButton>
  );
}

/**
 * One selectable option: a bordered tile like `OptionButton`, but it keeps
 * its radio or checkbox, because picking here only selects and Next or
 * Submit sends. Clicking anywhere on the tile selects it; the picked tile
 * takes the primary border.
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
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border bg-card px-3 py-2.5 shadow-xs transition-colors",
        "hover:bg-muted/60 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary ring-inset"
          : "border-border",
        error && !selected ? "border-destructive/60" : null,
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
