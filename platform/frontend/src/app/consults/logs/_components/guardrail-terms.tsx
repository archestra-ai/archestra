import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ExternalConsult } from "@/lib/openappa/external-consults.query";
import { cn } from "@/lib/utils/tailwind";

/** A guardrail term with a dotted underline, explained on hover. */
export function GuardrailTerm({
  label,
  explanation,
  className,
}: {
  label: string;
  explanation: string | undefined;
  className?: string;
}) {
  if (!explanation) return <span className={className}>{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "cursor-help underline decoration-muted-foreground/50 decoration-dotted underline-offset-[3px]",
            className,
          )}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-60">{explanation}</TooltipContent>
    </Tooltip>
  );
}

/** What each consult role does, in words. */
export const CONSULT_ROLE_TERMS: Record<
  string,
  { label: string; explanation: string }
> = {
  authority: {
    label: "Authority",
    explanation:
      "Decides whether a call may run at all: allows it, blocks it, or asks a person to approve it first.",
  },
  annotator: {
    label: "Annotator",
    explanation:
      "Reads what a tool returned and labels it: how far it can be trusted, and who may see it.",
  },
  sanitizer: {
    label: "Sanitizer",
    explanation:
      "Cleans a tool's result before the agent sees it, such as redacting personal data.",
  },
  audience_source: {
    label: "Audience source",
    explanation:
      "Looks up who belongs to an audience, such as the members of a team or channel.",
  },
  input: {
    label: "Input",
    explanation: "Supplies a value the policy needs to make its decision.",
  },
  context_provider: {
    label: "Context provider",
    explanation:
      "Adds context the policy reads when it decides, such as who owns a resource.",
  },
};

/** Where each consult was answered, in words. */
export const CONSULT_BACKEND_TERMS: Record<
  string,
  { label: string; explanation: string }
> = {
  url: {
    label: "HTTP",
    explanation: "An HTTP service the policy names, called with the request.",
  },
  command: {
    label: "Command",
    explanation:
      "A program the platform runs, sending the request and reading its answer.",
  },
  module: {
    label: "Module",
    explanation: "A plug-in loaded into the guardrails engine itself.",
  },
  llm: {
    label: "LLM",
    explanation:
      "A language model asked to judge the call or its result, through the LLM Proxy.",
  },
  jev: {
    label: "Jev",
    explanation:
      "A decision model that scores content, such as a tool call, instead of chatting.",
  },
  claude_code: {
    label: "Claude Code",
    explanation: "Claude Code, asked to judge the call or its result.",
  },
  hitl: {
    label: "Human review",
    explanation: "A person asked to decide, such as approving a call in chat.",
  },
  archestra: {
    label: "Archestra",
    explanation:
      "Archestra's built-in labeler, which asks the agent's model (or the organization's default).",
  },
};

/**
 * What the consult's answer said, in words: who approved, why it was
 * blocked, what was redacted, how the result was labeled. Null when the
 * answer has nothing to add to the outcome; the raw answer is always on the
 * right.
 */
export function consultAnswerSummary(consult: ExternalConsult): string | null {
  if (consult.outcome !== "answered") return null;
  const answer = consult.answer;
  if (!answer || typeof answer !== "object") return null;
  const fields = answer as Record<string, unknown>;

  if (fields.allow === false) {
    return typeof fields.reason === "string" ? fields.reason : null;
  }
  if (typeof fields.approved_by === "string") {
    return `Approved by ${fields.approved_by}${
      typeof fields.channel === "string" ? ` in ${fields.channel}` : ""
    }`;
  }
  if (Array.isArray(fields.redactions)) {
    const parts = fields.redactions.flatMap((item) => {
      const { kind, count } = (item ?? {}) as {
        kind?: unknown;
        count?: unknown;
      };
      if (typeof kind !== "string") return [];
      const n = typeof count === "number" ? count : 1;
      return [`${n} ${kind}${n === 1 ? "" : "s"}`];
    });
    return parts.length ? `Removed ${parts.join(", ")}` : null;
  }
  const label = [
    typeof fields.delta_trust === "string"
      ? `Trust ${fields.delta_trust}`
      : null,
    typeof fields.delta_audience === "string"
      ? `audience ${fields.delta_audience}`
      : null,
  ].filter(Boolean);
  if (label.length) return capitalize(label.join(" · "));
  return null;
}

// ============================================================================
// Internal helpers
// ============================================================================

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
