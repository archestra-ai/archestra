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
import {
  Select,
  SelectContent,
  SelectItem,
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

type AssertionType = EvalAssertion["type"];

const ASSERTION_TYPE_LABELS: Record<AssertionType, string> = {
  exact_match: "Exact match",
  contains: "Contains",
  not_contains: "Does not contain",
  regex: "Matches regex",
  tool_called: "Tool was called",
  tool_not_called: "Tool was not called",
  llm_judge: "LLM judge",
};

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

/** Create (no `evalCase`) or edit (`evalCase` set) a case within a suite. */
export function EvalCaseDialog({
  open,
  onOpenChange,
  suiteId,
  evalCase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suiteId: string;
  evalCase?: EvalCase | null;
}) {
  const createCase = useCreateEvalCase();
  const updateCase = useUpdateEvalCase();
  const isEdit = !!evalCase;

  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const [drafts, setDrafts] = useState<AssertionDraft[]>([{ ...EMPTY_DRAFT }]);

  useEffect(() => {
    if (open) {
      setName(evalCase?.name ?? "");
      setInput(evalCase?.input ?? "");
      setDrafts(
        evalCase && evalCase.assertions.length > 0
          ? evalCase.assertions.map(draftFromAssertion)
          : [{ ...EMPTY_DRAFT }],
      );
    }
  }, [open, evalCase]);

  const assertions = drafts
    .map(buildAssertion)
    .filter((a): a is EvalAssertion => a !== null);
  const canSubmit =
    name.trim().length > 0 &&
    input.trim().length > 0 &&
    assertions.length === drafts.length &&
    assertions.length > 0;

  const updateDraft = (index: number, patch: Partial<AssertionDraft>) => {
    setDrafts((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)),
    );
  };

  const submit = async () => {
    if (!canSubmit) return;
    if (isEdit && evalCase) {
      await updateCase.mutateAsync({
        caseId: evalCase.id,
        body: { name, input, assertions },
      });
    } else {
      await createCase.mutateAsync({
        suiteId,
        body: { name, input, assertions },
      });
    }
    onOpenChange(false);
  };

  const pending = createCase.isPending || updateCase.isPending;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Edit case" : "New case"}
      description="One input message for the agent, plus the assertions its answer must satisfy. All assertions must pass for the case to pass."
      size="medium"
    >
      <DialogForm onSubmit={() => void submit()}>
        <DialogBody className="space-y-4">
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
            <Label htmlFor="eval-case-input">Input</Label>
            <Textarea
              id="eval-case-input"
              placeholder="The message sent to the agent"
              rows={3}
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </div>

          <div className="space-y-3">
            <Label>Assertions</Label>
            {drafts.map((draft, index) => (
              <AssertionEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: drafts have no stable identity
                key={index}
                draft={draft}
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

function AssertionEditor({
  draft,
  onChange,
  onRemove,
}: {
  draft: AssertionDraft;
  onChange: (patch: Partial<AssertionDraft>) => void;
  onRemove?: () => void;
}) {
  const usesValues =
    draft.type === "contains" ||
    draft.type === "not_contains" ||
    draft.type === "tool_called" ||
    draft.type === "tool_not_called";
  const valuesLabel =
    draft.type === "tool_called" || draft.type === "tool_not_called"
      ? "Tool names (comma-separated)"
      : "Values (comma-separated)";

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Select
          value={draft.type}
          onValueChange={(value) => onChange({ type: value as AssertionType })}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(ASSERTION_TYPE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {draft.type === "contains" && (
          <Select
            value={draft.mode}
            onValueChange={(value) =>
              onChange({ mode: value as "all" | "any" })
            }
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">all</SelectItem>
              <SelectItem value="any">any</SelectItem>
            </SelectContent>
          </Select>
        )}
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

      {draft.type === "exact_match" && (
        <Input
          placeholder="Expected output"
          value={draft.text}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      )}
      {usesValues && (
        <Input
          placeholder={valuesLabel}
          value={draft.values}
          onChange={(event) => onChange({ values: event.target.value })}
        />
      )}
      {draft.type === "regex" && (
        <div className="flex gap-2">
          <Input
            placeholder="Pattern, e.g. ^Order #\d+"
            value={draft.text}
            onChange={(event) => onChange({ text: event.target.value })}
          />
          <Input
            className="w-24"
            placeholder="flags"
            value={draft.extra}
            onChange={(event) => onChange({ extra: event.target.value })}
          />
        </div>
      )}
      {draft.type === "llm_judge" && (
        <div className="space-y-2">
          <Textarea
            placeholder="Criteria the output must satisfy, e.g. politely explains the refund policy"
            rows={2}
            value={draft.text}
            onChange={(event) => onChange({ text: event.target.value })}
          />
          <Textarea
            placeholder="Reference answer (optional)"
            rows={2}
            value={draft.extra}
            onChange={(event) => onChange({ extra: event.target.value })}
          />
        </div>
      )}
    </div>
  );
}
