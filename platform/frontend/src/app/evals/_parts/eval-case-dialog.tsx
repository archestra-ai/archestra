"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  type EvalAssertion,
  type EvalCase,
  useCreateEvalCase,
  useUpdateEvalCase,
} from "@/lib/evals/eval.query";
import { useTools } from "@/lib/tools/tool.query";
import { summarizeAssertion } from "./assertion-summary";

type AssertionType = EvalAssertion["type"];

/** A prefilled starting point ("Start from an example"). */
export type EvalCaseTemplate = {
  name: string;
  messages: string[];
  assertions: EvalAssertion[];
};

const MAX_MESSAGES = 20;

/**
 * Editable draft of one assertion. One shape for every type keeps the editor
 * simple; buildAssertion() narrows to the API payload per type.
 */
type AssertionDraft = {
  type: AssertionType;
  /** exact_match expected / regex pattern / llm_judge criteria */
  text: string;
  /** contains / not_contains / tool names — comma-separated in the editor */
  values: string;
  mode: "all" | "any";
  caseSensitive: boolean;
  /** exact_match whitespace trimming; round-tripped, not exposed in the UI */
  trim: boolean;
  /** llm_judge optional reference answer / regex flags */
  extra: string;
};

const EMPTY_DRAFT: AssertionDraft = {
  type: "contains",
  text: "",
  values: "",
  mode: "all",
  caseSensitive: false,
  trim: true,
  extra: "",
};

/** Create (no `evalCase`) or edit (`evalCase` set) a case within a suite. */
export function EvalCaseDialog({
  open,
  onOpenChange,
  suiteId,
  evalCase,
  template,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suiteId: string;
  evalCase?: EvalCase | null;
  /** Prefill for a new case; ignored when editing an existing one. */
  template?: EvalCaseTemplate | null;
}) {
  const createCase = useCreateEvalCase();
  const updateCase = useUpdateEvalCase();
  const isEdit = !!evalCase;

  const [name, setName] = useState("");
  const [messages, setMessages] = useState<string[]>([""]);
  const [drafts, setDrafts] = useState<AssertionDraft[]>([{ ...EMPTY_DRAFT }]);

  // The org's tool names feed the tool-assertion picker so nobody has to
  // remember gateway tool names by heart.
  const toolsQuery = useTools({});
  const toolNames = [
    ...new Set((toolsQuery.data ?? []).map((tool) => tool.name)),
  ].sort();

  useEffect(() => {
    if (!open) return;
    const source = evalCase ?? template ?? null;
    setName(source?.name ?? "");
    setMessages(
      source && source.messages.length > 0 ? [...source.messages] : [""],
    );
    setDrafts(
      source && source.assertions.length > 0
        ? source.assertions.map(draftFromAssertion)
        : [{ ...EMPTY_DRAFT }],
    );
  }, [open, evalCase, template]);

  const assertions = drafts
    .map(buildAssertion)
    .filter((a): a is EvalAssertion => a !== null);
  const trimmedMessages = messages.map((message) => message.trim());
  const canSubmit =
    name.trim().length > 0 &&
    trimmedMessages.every((message) => message.length > 0) &&
    assertions.length === drafts.length &&
    assertions.length > 0;

  const updateDraft = (index: number, patch: Partial<AssertionDraft>) => {
    setDrafts((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)),
    );
  };

  const submit = async () => {
    if (!canSubmit) return;
    const body = { name, messages: trimmedMessages, assertions };
    if (isEdit && evalCase) {
      await updateCase.mutateAsync({ caseId: evalCase.id, body });
    } else {
      await createCase.mutateAsync({ suiteId, body });
    }
    onOpenChange(false);
  };

  const pending = createCase.isPending || updateCase.isPending;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Edit case" : "New case"}
      description="A case is one test: a message you would send the agent, plus assertions — checks its answer must pass. All assertions must pass for the case to pass."
      size="medium"
    >
      <DialogForm onSubmit={() => void submit()}>
        <DialogBody className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="eval-case-name">Name</Label>
            <Input
              id="eval-case-name"
              placeholder="e.g. Refund policy question"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="eval-case-message-0">
              {messages.length > 1 ? "Messages" : "Message"}
            </Label>
            {messages.map((message, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: ordered turn list without ids
                key={index}
                className="flex items-start gap-2"
              >
                <Textarea
                  id={`eval-case-message-${index}`}
                  aria-label={index === 0 ? undefined : `Message ${index + 1}`}
                  placeholder={
                    index === 0
                      ? "What you would ask the agent, e.g. What is our refund policy?"
                      : "Follow-up sent after the agent answers"
                  }
                  rows={index === 0 ? 3 : 2}
                  value={message}
                  onChange={(event) =>
                    setMessages((current) =>
                      current.map((m, i) =>
                        i === index ? event.target.value : m,
                      ),
                    )
                  }
                />
                {messages.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove message ${index + 1}`}
                    onClick={() =>
                      setMessages((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMessages((current) => [...current, ""])}
              disabled={messages.length >= MAX_MESSAGES}
            >
              <Plus className="mr-1 h-3 w-3" />
              <span>Add follow-up</span>
            </Button>
            <p className="text-muted-foreground text-xs">
              Messages are sent in order within one conversation. Assertions
              grade the agent's answer to the last one.
            </p>
          </div>

          <div className="space-y-3">
            <div>
              <Label>Assertions</Label>
              <p className="text-muted-foreground mt-1 text-xs">
                What must be true of the agent's final answer — or of the tools
                it used — for this case to pass.
              </p>
            </div>
            {drafts.map((draft, index) => (
              <AssertionEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: drafts have no stable identity
                key={index}
                draft={draft}
                toolNames={toolNames}
                onChange={(patch) => updateDraft(index, patch)}
                onRemove={
                  drafts.length > 1
                    ? () =>
                        setDrafts((current) =>
                          current.filter((_, i) => i !== index),
                        )
                    : undefined
                }
              />
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setDrafts((current) => [...current, { ...EMPTY_DRAFT }])
              }
              disabled={drafts.length >= 20}
            >
              <Plus className="mr-1 h-3 w-3" />
              <span>Add assertion</span>
            </Button>
          </div>
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || pending}>
            <span>{isEdit ? "Save case" : "Add case"}</span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

// === Internal helpers ===

function AssertionEditor({
  draft,
  toolNames,
  onChange,
  onRemove,
}: {
  draft: AssertionDraft;
  toolNames: string[];
  onChange: (patch: Partial<AssertionDraft>) => void;
  onRemove?: () => void;
}) {
  const built = buildAssertion(draft);

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Select
          value={draft.type}
          onValueChange={(value) => onChange({ type: value as AssertionType })}
        >
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>The answer's text</SelectLabel>
              <SelectItem value="contains">Contains text</SelectItem>
              <SelectItem value="not_contains">
                Does not contain text
              </SelectItem>
              <SelectItem value="exact_match">Exactly equals</SelectItem>
              <SelectItem value="regex">Matches a pattern (regex)</SelectItem>
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>The tools the agent used</SelectLabel>
              <SelectItem value="tool_called">Tool was called</SelectItem>
              <SelectItem value="tool_not_called">
                Tool was not called
              </SelectItem>
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Model-graded</SelectLabel>
              <SelectItem value="llm_judge">LLM judge</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="flex-1" />
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            aria-label="Remove assertion"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {(draft.type === "contains" || draft.type === "not_contains") && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs">
              {draft.type === "contains"
                ? "Text to look for"
                : "Text that must not appear"}
            </Label>
            {draft.type === "contains" && (
              <Select
                value={draft.mode}
                onValueChange={(value) =>
                  onChange({ mode: value as "all" | "any" })
                }
              >
                <SelectTrigger className="h-7 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all values required</SelectItem>
                  <SelectItem value="any">any one is enough</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
          <Input
            placeholder={
              draft.type === "contains" ? "e.g. refund, 30 days" : "e.g. sorry"
            }
            value={draft.values}
            onChange={(event) => onChange({ values: event.target.value })}
          />
          <p className="text-muted-foreground text-xs">
            Separate several values with commas. Matching is case-insensitive.
          </p>
        </div>
      )}

      {draft.type === "exact_match" && (
        <div className="space-y-2">
          <Label className="text-xs">Expected answer</Label>
          <Input
            placeholder="The exact text the agent must answer with"
            value={draft.text}
            onChange={(event) => onChange({ text: event.target.value })}
          />
          <p className="text-muted-foreground text-xs">
            Whole-answer comparison (case-insensitive, whitespace trimmed). Best
            for short, deterministic answers.
          </p>
        </div>
      )}

      {draft.type === "regex" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Pattern</Label>
              <Input
                placeholder={"e.g. ^Order #\\d+"}
                value={draft.text}
                onChange={(event) => onChange({ text: event.target.value })}
              />
            </div>
            <div className="w-24 space-y-1">
              <Label className="text-xs">Flags</Label>
              <Input
                placeholder="i, m, s"
                value={draft.extra}
                onChange={(event) => onChange({ extra: event.target.value })}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            JavaScript regular expression tested against the whole answer.
          </p>
        </div>
      )}

      {(draft.type === "tool_called" || draft.type === "tool_not_called") && (
        <div className="space-y-2">
          <Label className="text-xs">Tools</Label>
          {toolNames.length > 0 ? (
            <MultiSelectCombobox
              options={[
                ...new Set([...toolNames, ...splitValues(draft.values)]),
              ].map((toolName) => ({ value: toolName, label: toolName }))}
              value={splitValues(draft.values)}
              onChange={(value) => onChange({ values: value.join(", ") })}
              placeholder="Search your tools…"
              emptyMessage="No tools match."
            />
          ) : (
            <Input
              placeholder="Tool names, comma-separated"
              value={draft.values}
              onChange={(event) => onChange({ values: event.target.value })}
            />
          )}
          <p className="text-muted-foreground text-xs">
            {draft.type === "tool_called"
              ? "Passes only if the agent called every listed tool during the case."
              : "Passes only if the agent called none of the listed tools."}
          </p>
        </div>
      )}

      {draft.type === "llm_judge" && (
        <div className="space-y-2">
          <Label className="text-xs">Pass criteria</Label>
          <Textarea
            placeholder="Plain language, e.g. politely explains the refund policy and mentions the 30-day window"
            rows={2}
            value={draft.text}
            onChange={(event) => onChange({ text: event.target.value })}
          />
          <Label className="text-xs">Reference answer (optional)</Label>
          <Textarea
            placeholder="A known-good answer the judge can compare against"
            rows={2}
            value={draft.extra}
            onChange={(event) => onChange({ extra: event.target.value })}
          />
          <p className="text-muted-foreground text-xs">
            A model reads the agent's answer and decides pass or fail against
            these criteria, using your organization's default LLM.
          </p>
        </div>
      )}

      <p className="text-muted-foreground border-t pt-2 text-xs">
        {built ? (
          <span>Checks: {summarizeAssertion(built)}</span>
        ) : (
          <span>
            Incomplete — this assertion needs a value before the case can be
            saved.
          </span>
        )}
      </p>
    </div>
  );
}

function draftFromAssertion(assertion: EvalAssertion): AssertionDraft {
  switch (assertion.type) {
    case "exact_match":
      return {
        ...EMPTY_DRAFT,
        type: assertion.type,
        text: assertion.expected,
        caseSensitive: assertion.caseSensitive ?? false,
        trim: assertion.trim ?? true,
      };
    case "contains":
      return {
        ...EMPTY_DRAFT,
        type: assertion.type,
        values: assertion.values.join(", "),
        mode: assertion.mode ?? "all",
        caseSensitive: assertion.caseSensitive ?? false,
      };
    case "not_contains":
      return {
        ...EMPTY_DRAFT,
        type: assertion.type,
        values: assertion.values.join(", "),
        caseSensitive: assertion.caseSensitive ?? false,
      };
    case "regex":
      return {
        ...EMPTY_DRAFT,
        type: assertion.type,
        text: assertion.pattern,
        extra: assertion.flags ?? "",
      };
    case "tool_called":
    case "tool_not_called":
      return {
        ...EMPTY_DRAFT,
        type: assertion.type,
        values: assertion.toolNames.join(", "),
      };
    case "llm_judge":
      return {
        ...EMPTY_DRAFT,
        type: assertion.type,
        text: assertion.criteria,
        extra: assertion.expected ?? "",
      };
  }
}

function splitValues(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildAssertion(draft: AssertionDraft): EvalAssertion | null {
  switch (draft.type) {
    case "exact_match":
      return draft.text
        ? {
            type: draft.type,
            expected: draft.text,
            caseSensitive: draft.caseSensitive,
            trim: draft.trim,
          }
        : null;
    case "contains": {
      const values = splitValues(draft.values);
      return values.length > 0
        ? {
            type: draft.type,
            values,
            mode: draft.mode,
            caseSensitive: draft.caseSensitive,
          }
        : null;
    }
    case "not_contains": {
      const values = splitValues(draft.values);
      return values.length > 0
        ? { type: draft.type, values, caseSensitive: draft.caseSensitive }
        : null;
    }
    case "regex":
      return draft.text
        ? {
            type: draft.type,
            pattern: draft.text,
            ...(draft.extra ? { flags: draft.extra } : {}),
          }
        : null;
    case "tool_called":
    case "tool_not_called": {
      const toolNames = splitValues(draft.values);
      return toolNames.length > 0 ? { type: draft.type, toolNames } : null;
    }
    case "llm_judge":
      return draft.text
        ? {
            type: draft.type,
            criteria: draft.text,
            ...(draft.extra ? { expected: draft.extra } : {}),
          }
        : null;
  }
}
