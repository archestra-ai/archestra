"use client";
// design-arena: do not commit
// Shared arena state for the guardrails prototypes: the mock data, which
// consult is open in the details pane, and the pane that shows it.

import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { toConsultView } from "@/app/consults/logs/_components/consult-details";
import { cn } from "@/lib/utils/tailwind";
import { ConsultDetails } from "../consult-details";
import { OverviewSection } from "../overview-parts";
import { RequestDetails } from "../request-details";
import type { Timeline } from "../session-timeline";
import {
  buildGuardrailsMock,
  DECISION_TONE,
  type GuardrailsData,
  type MockConsult,
  ROLE_LABEL,
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
  onSelectSpan,
  children,
}: {
  timeline: Timeline | null;
  onSelectSpan: (key: string | null) => void;
  children: ReactNode;
}) {
  const guardrails = useMemo(() => buildGuardrailsMock(timeline), [timeline]);
  const [selectedConsultKey, setSelectedConsultKey] = useState<string | null>(
    null,
  );
  const state: ArenaState = {
    guardrails,
    selectedConsultKey,
    selectConsult: (key) => {
      const consult = guardrails?.consults.find((c) => c.key === key);
      if (consult?.toolCallKey) onSelectSpan(consult.toolCallKey);
      setSelectedConsultKey(key);
    },
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
        return checks.length > 0 ? (
          <GuardrailChecks checks={checks} onOpen={selectConsult} />
        ) : null;
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
                  {ROLE_LABEL[check.role]} ·{" "}
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
