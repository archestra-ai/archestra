import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { prettyPrintJson } from "./hook-run-chip.utils";

export interface HookRunChipData {
  hookEventName?: string;
  fileName?: string;
  outcome?: string;
  exitCode?: number | null;
  toolName?: string;
  /** Debug bodies — only present when the conversation has hook debug mode on. */
  stdout?: string;
  stderr?: string;
  /** The received payload, JSON-stringified (capped). */
  payloadJson?: string;
  durationMs?: number;
}

// Outcome → text tone. proceeded is muted; blocked warns; error/timeout alarm.
const OUTCOME_TONE: Record<string, string> = {
  proceeded: "text-muted-foreground",
  blocked: "text-amber-600 dark:text-amber-500",
  error: "text-red-600 dark:text-red-500",
  timeout: "text-red-600 dark:text-red-500",
};

/**
 * Model-invisible debug entry for a single hook run, rendered inline in the chat
 * thread when admin debug mode is on. The one-line summary (lifecycle event,
 * script file, outcome, exit code, duration) is always shown; when stdout /
 * stderr / payload were captured the row expands to reveal them. The backend
 * only delivers these parts to admins on debug-enabled conversations.
 */
export function HookRunChip({ data }: { data?: HookRunChipData }) {
  if (!data) {
    return null;
  }
  const tone = OUTCOME_TONE[data.outcome ?? ""] ?? "text-muted-foreground";
  const hasBodies = Boolean(data.stdout || data.stderr || data.payloadJson);
  const titleText = `Hook ${data.hookEventName ?? ""} · ${
    data.fileName ?? ""
  } · ${data.outcome ?? ""}${
    data.exitCode != null ? ` (exit ${data.exitCode})` : ""
  }`;

  const summary = (
    <>
      <span aria-hidden>⚙</span>
      <span className="font-semibold">{data.hookEventName}</span>
      {data.toolName ? (
        <span className="opacity-80">→ {data.toolName}</span>
      ) : null}
      <span className="opacity-60">·</span>
      <span>{data.fileName}</span>
      <span className="opacity-60">·</span>
      <span>{data.outcome}</span>
      {data.exitCode != null ? (
        <span className="opacity-60">(exit {data.exitCode})</span>
      ) : null}
      {typeof data.durationMs === "number" ? (
        <span className="opacity-60">· {data.durationMs}ms</span>
      ) : null}
    </>
  );

  const summaryClass = `flex flex-wrap items-center gap-1.5 font-mono text-xs ${tone}`;

  if (!hasBodies) {
    return (
      <div
        data-testid="hook-run-chip"
        className={`my-1 ${summaryClass}`}
        title={titleText}
      >
        {summary}
      </div>
    );
  }

  return (
    <Collapsible data-testid="hook-run-chip" className="my-1">
      <CollapsibleTrigger
        className={`group w-full text-left ${summaryClass}`}
        title={titleText}
      >
        <span
          aria-hidden
          className="opacity-60 transition-transform group-data-[state=open]:rotate-90"
        >
          ▸
        </span>
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-4 flex flex-col gap-2 border-l pl-3 font-mono text-xs text-muted-foreground">
          {data.payloadJson ? (
            <HookBody
              label="payload"
              body={prettyPrintJson(data.payloadJson)}
            />
          ) : null}
          {data.stdout ? <HookBody label="stdout" body={data.stdout} /> : null}
          {data.stderr ? <HookBody label="stderr" body={data.stderr} /> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function HookBody({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <div className="mb-0.5 uppercase tracking-wide opacity-60">{label}</div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-foreground/80">
        {body}
      </pre>
    </div>
  );
}
