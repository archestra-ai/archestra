"use client";
// design-arena: do not commit
// Shared arena state for the guardrails prototypes: the mock data, which
// consult is open in the details pane, and the pane that shows it.

import { ArrowRight, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toConsultView } from "@/app/consults/logs/_components/consult-details";
import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeature } from "@/lib/config/config.query";
import { LLM_LOG_FOCUS_PARAM } from "@/lib/interactions/llm-log-links";
import { readMcpToolCall } from "@/lib/mcp-logs/tool-call-content";
import {
  type ExternalConsult,
  useSessionConsults,
} from "@/lib/openappa/external-consults.query";
import { cn } from "@/lib/utils/tailwind";
import { ConsultDetails } from "../consult-details";
import { OverviewSection } from "../overview-parts";
import { RequestDetails } from "../request-details";
import type { Timeline, ToolCallSpan } from "../session-timeline";
import {
  AUDIENCE_TONE,
  buildGuardrailsMock,
  DECISION_TONE,
  type GuardrailsData,
  type LabelSegment,
  type MockConsult,
  ROLE_LABEL,
  TRUST_TONE,
} from "./guardrails-mock";

type ArenaState = {
  guardrails: GuardrailsData | null;
  /** The consult open in the details pane, if any. */
  selectedConsultKey: string | null;
  /**
   * Opens a consult in the details pane and selects the tool call it belongs
   * to in the list. Null closes it.
   */
  selectConsult: (key: string | null) => void;
  /** Wraps the page's span selection so picking a span closes a consult. */
  selectSpan: (key: string | null) => void;
};

const ArenaContext = createContext<ArenaState | null>(null);

export function GuardrailsArenaProvider({
  timeline,
  sessionId,
  onSelectSpan,
  children,
}: {
  timeline: Timeline | null;
  /** The LLM session, whose real consults replace the mock ones. */
  sessionId: string;
  onSelectSpan: (key: string | null) => void;
  children: ReactNode;
}) {
  const openappaEnabled = useFeature("openappaEnabled");
  const { data: realConsults } = useSessionConsults({
    llmSessionId: sessionId,
    enabled: Boolean(openappaEnabled),
  });
  const guardrails = useMemo(() => {
    const mock = buildGuardrailsMock(timeline);
    if (!mock || !timeline || !realConsults) return mock;
    // Real consults once loaded (none means no checks); labels stay mock.
    const consults = realConsults.map((consult) =>
      fromRecord({ consult, timeline, timeToX: mock.timeToX }),
    );
    const labels = mock.labels.map((segment) =>
      segment.cause
        ? {
            ...segment,
            cause: {
              ...segment.cause,
              consultKey:
                consults.find(
                  (c) =>
                    c.toolCallKey === segment.cause?.toolCallKey &&
                    c.role === "annotator",
                )?.key ?? null,
            },
          }
        : segment,
    );
    return { ...mock, consults, labels };
  }, [timeline, realConsults]);

  const [selectedConsultKey, setSelectedConsultKey] = useState<string | null>(
    null,
  );
  const selectConsult = (key: string | null) => {
    const consult = guardrails?.consults.find((c) => c.key === key);
    if (consult?.toolCallKey) onSelectSpan(consult.toolCallKey);
    setSelectedConsultKey(key);
  };

  // `?consult=<id>` (the consult log's link) opens that check once it loads.
  const searchParams = useSearchParams();
  const linkedConsult = searchParams.get(LLM_LOG_FOCUS_PARAM.consult);
  const appliedLink = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedConsult || appliedLink.current === linkedConsult) return;
    const key = `consult:${linkedConsult}`;
    if (!guardrails?.consults.some((c) => c.key === key)) return;
    appliedLink.current = linkedConsult;
    selectConsult(key);
  });

  const state: ArenaState = {
    guardrails,
    selectedConsultKey,
    selectConsult,
    selectSpan: (key) => {
      setSelectedConsultKey(null);
      onSelectSpan(key);
    },
  };
  return (
    <ArenaContext.Provider value={state}>{children}</ArenaContext.Provider>
  );
}

export function useGuardrailsArena(): ArenaState {
  const state = useContext(ArenaContext);
  if (!state) throw new Error("GuardrailsArenaProvider missing");
  return state;
}

/**
 * The page's details pane, plus guardrails: a selected consult replaces it
 * with the consult's own details, and a selected tool call lists its checks.
 */
export function ArenaDetails(props: ComponentProps<typeof RequestDetails>) {
  const { guardrails, selectedConsultKey, selectConsult } =
    useGuardrailsArena();
  const consult = guardrails?.consults.find(
    (c) => c.key === selectedConsultKey,
  );
  if (consult) {
    return (
      <ConsultDetails
        height={props.height}
        view={toConsultView(consult.record)}
        toolName={consult.toolName}
        when={consult.beforeCall ? "Before the call" : "On the result"}
        verdict={<DecisionLine consult={consult} />}
        onBack={consult.toolCallKey ? () => selectConsult(null) : null}
      />
    );
  }
  return (
    <RequestDetails
      {...props}
      toolCallChecks={(span) => {
        const checks =
          guardrails?.consults.filter((c) => c.toolCallKey === span.key) ?? [];
        const changeIndex =
          guardrails?.labels.findIndex(
            (segment) => segment.cause?.toolCallKey === span.key,
          ) ?? -1;
        const change =
          guardrails && changeIndex > 0
            ? {
                before: guardrails.labels[changeIndex - 1],
                after: guardrails.labels[changeIndex],
              }
            : null;
        return (
          <>
            {change ? (
              <LabelChangeWhy
                before={change.before}
                after={change.after}
                onOpenConsult={selectConsult}
              />
            ) : null}
            {checks.length > 0 ? (
              <GuardrailChecks checks={checks} onOpen={selectConsult} />
            ) : null}
          </>
        );
      }}
    />
  );
}

/** The checks a tool call went through, each opening its consult. */
export function GuardrailChecks({
  checks,
  onOpen,
}: {
  checks: MockConsult[];
  onOpen: (key: string) => void;
}) {
  return (
    <OverviewSection title="Guardrail checks">
      <ul className="-mx-1.5 space-y-0.5">
        {checks.map((check) => (
          <li key={check.key}>
            <button
              type="button"
              onClick={() => onOpen(check.key)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted"
            >
              <DecisionIcon consult={check} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono">
                  {check.externalName}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  <RoleTerm role={check.role} /> ·{" "}
                  {check.beforeCall ? "before the call" : "on the result"}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-sm px-1 text-[10px] leading-4 font-medium",
                  DECISION_TONE[check.decision].chip,
                )}
              >
                {DECISION_TONE[check.decision].label}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </OverviewSection>
  );
}

export function DecisionIcon({
  consult,
  className,
}: {
  consult: MockConsult;
  className?: string;
}) {
  const Icon =
    consult.decision === "blocked"
      ? ShieldX
      : consult.outcome !== "answered"
        ? ShieldAlert
        : ShieldCheck;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "size-3.5 shrink-0",
        consult.decision === "blocked"
          ? "text-rose-600 dark:text-rose-400"
          : consult.outcome !== "answered"
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground",
        className,
      )}
    />
  );
}

function DecisionLine({ consult }: { consult: MockConsult }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        className={cn(
          "shrink-0 rounded-sm px-1 text-[10px] leading-4 font-medium",
          DECISION_TONE[consult.decision].chip,
        )}
      >
        {DECISION_TONE[consult.decision].label}
      </span>
      <span className="truncate text-muted-foreground" title={consult.answer}>
        {consult.answer}
      </span>
    </span>
  );
}

/**
 * Why a tool call moved the session's label: the change, the reason in
 * words, and the policy excerpt that made it.
 */
export function LabelChangeWhy({
  before,
  after,
  onOpenConsult,
}: {
  before: LabelSegment;
  after: LabelSegment;
  onOpenConsult: (key: string) => void;
}) {
  const cause = after.cause;
  if (!cause) return null;
  const parts: { name: string; from: string; to: string; tone: string }[] = [];
  if (before.trust !== after.trust) {
    parts.push({
      name: "Trust",
      from: TRUST_TONE[before.trust].label,
      to: TRUST_TONE[after.trust].label,
      tone: TRUST_TONE[after.trust].text,
    });
  }
  if (before.audience !== after.audience) {
    parts.push({
      name: "Audience",
      from: AUDIENCE_TONE[before.audience].label,
      to: AUDIENCE_TONE[after.audience].label,
      tone: AUDIENCE_TONE[after.audience].text,
    });
  }
  return (
    <OverviewSection title="Why the label changed">
      <ul className="space-y-0.5">
        {parts.map((part) => (
          <li key={part.name} className="flex items-center gap-1.5 text-xs">
            <span className="w-14 shrink-0 text-muted-foreground">
              {part.name}
            </span>
            <span className="text-muted-foreground line-through decoration-muted-foreground/40">
              {part.from}
            </span>
            <ArrowRight
              className="size-3 shrink-0 text-muted-foreground/60"
              aria-hidden="true"
            />
            <span className={cn("font-medium", part.tone)}>{part.to}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-[18px] text-foreground/85">
        {cause.explanation}
      </p>
      <figure className="mt-2 overflow-hidden rounded-md border bg-background/60">
        <figcaption className="flex items-center justify-between gap-2 border-b px-2 py-1 text-[10px] text-muted-foreground">
          <span className="truncate">{cause.ruleSource}</span>
          <span className="shrink-0 font-mono">toml</span>
        </figcaption>
        <CodeBlock
          code={cause.rule}
          language="toml"
          className="rounded-none border-0"
          // The highlighter sets text-sm on its <code>; match the sentence
          // above instead.
          contentClassName="max-h-40 overflow-auto [&_code]:!text-xs [&_code]:!leading-[18px]"
          // Policy lines keep their shape; a long one scrolls sideways.
          contentStyle={{
            fontSize: "0.75rem",
            padding: "0.375rem 0.5rem",
            overflowX: "auto",
            whiteSpace: "pre",
          }}
        />
      </figure>
      {cause.consultKey ? (
        <button
          type="button"
          onClick={() => cause.consultKey && onOpenConsult(cause.consultKey)}
          className="mt-2 text-xs text-primary underline-offset-4 hover:underline"
        >
          Open the check that decided it
        </button>
      ) : null}
    </OverviewSection>
  );
}

/** A guardrail role in words, explained on hover. */
export function RoleTerm({ role }: { role: MockConsult["role"] }) {
  return <Term label={ROLE_LABEL[role]} explanation={ROLE_EXPLANATION[role]} />;
}

/** A check's outcome in words, explained on hover. */
export function DecisionTerm({
  decision,
  className,
}: {
  decision: MockConsult["decision"];
  className?: string;
}) {
  return (
    <Term
      label={DECISION_TONE[decision].label}
      explanation={DECISION_EXPLANATION[decision]}
      className={cn(DECISION_TONE[decision].text, className)}
    />
  );
}

export const ROLE_EXPLANATION: Record<MockConsult["role"], string> = {
  authority:
    "Decides whether a call may run at all: allows it, blocks it, or asks a person to approve it first.",
  annotator:
    "Reads what a tool returned and labels it: how far it can be trusted, and who may see it.",
  sanitizer:
    "Cleans a tool's result before the agent sees it, such as redacting personal data.",
  audience_source:
    "Looks up who belongs to an audience, such as the members of a team or channel.",
};

const DECISION_EXPLANATION: Record<MockConsult["decision"], string> = {
  allowed: "The call was allowed to run.",
  approved: "A person approved the call before it ran.",
  blocked: "The call was stopped and never ran.",
  labeled:
    "The result was labeled; the session's trust or audience may have changed.",
  redacted: "Parts of the result were removed before the agent saw them.",
};

function Term({
  label,
  explanation,
  className,
}: {
  label: string;
  explanation: string;
  className?: string;
}) {
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

/** A stored consult in the trace's shape: placed on the axis, tied to its call. */
function fromRecord({
  consult,
  timeline,
  timeToX,
}: {
  consult: ExternalConsult;
  timeline: Timeline;
  timeToX: (ms: number) => number;
}): MockConsult {
  const start = new Date(consult.startedAt).getTime();
  const end = start + consult.durationMs;
  const tool = consult.callId
    ? timeline.spans.find(
        (span): span is ToolCallSpan =>
          span.type === "tool" &&
          span.call.llmToolCallId != null &&
          modelCallId(span.call.llmToolCallId) === consult.callId,
      )
    : undefined;
  const role = (
    ["authority", "annotator", "sanitizer", "audience_source"] as const
  ).includes(consult.role as MockConsult["role"])
    ? (consult.role as MockConsult["role"])
    : "annotator";
  const answered = consult.outcome === "answered";
  const answer = (consult.answer ?? {}) as Record<string, unknown>;
  const decision: MockConsult["decision"] =
    role === "authority"
      ? !answered || answer.allow === false
        ? "blocked"
        : answer.approved_by
          ? "approved"
          : "allowed"
      : role === "sanitizer"
        ? "redacted"
        : "labeled";
  const x = timeToX(start);
  return {
    id: consult.id,
    key: `consult:${consult.id}`,
    role,
    externalName: consult.externalName,
    backend: consult.backend,
    outcome:
      consult.outcome === "answered" || consult.outcome === "timeout"
        ? consult.outcome
        : "non_success",
    decision,
    answer: summarizeAnswer(consult.answer),
    start,
    end,
    durationMs: consult.durationMs,
    x,
    w: Math.max(0, timeToX(end) - x),
    toolCallKey: tool?.key ?? null,
    toolName: tool ? (readMcpToolCall(tool.call).toolName ?? null) : null,
    beforeCall: role === "authority",
    record: consult,
  };
}

/**
 * The provider's id inside a trajectory stamp (`appat1` + base64url of
 * `<session>\0<call id>` + a 22-character tag), or the id as given.
 */
function modelCallId(id: string): string {
  if (!id.startsWith("appat1") || id.length <= 6 + 22) return id;
  try {
    const payload = id.slice(6, -22).replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(
      payload.padEnd(Math.ceil(payload.length / 4) * 4, "="),
    );
    const separator = decoded.indexOf("\u0000");
    return separator > 0 ? decoded.slice(separator + 1) : id;
  } catch {
    return id;
  }
}

function summarizeAnswer(answer: unknown): string {
  if (answer == null) return "No answer";
  const text = typeof answer === "string" ? answer : JSON.stringify(answer);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
