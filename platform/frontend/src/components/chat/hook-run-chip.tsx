export interface HookRunChipData {
  hookEventName?: string;
  fileName?: string;
  outcome?: string;
  exitCode?: number | null;
  toolName?: string;
}

// Outcome → text tone. proceeded is muted; blocked warns; error/timeout alarm.
const OUTCOME_TONE: Record<string, string> = {
  proceeded: "text-muted-foreground",
  blocked: "text-amber-600 dark:text-amber-500",
  error: "text-red-600 dark:text-red-500",
  timeout: "text-red-600 dark:text-red-500",
};

/**
 * Compact, model-invisible debug entry for a single hook run, rendered inline in
 * the chat thread (Phase 2 — Visibility). Outcome-only: lifecycle event, script
 * file, outcome, and exit code, plus the tool name for Pre/PostToolUse entries.
 */
export function HookRunChip({ data }: { data?: HookRunChipData }) {
  if (!data) {
    return null;
  }
  const tone = OUTCOME_TONE[data.outcome ?? ""] ?? "text-muted-foreground";
  return (
    <div
      data-testid="hook-run-chip"
      className={`my-1 flex flex-wrap items-center gap-1.5 font-mono text-xs ${tone}`}
      title={`Hook ${data.hookEventName ?? ""} · ${data.fileName ?? ""} · ${
        data.outcome ?? ""
      }${data.exitCode != null ? ` (exit ${data.exitCode})` : ""}`}
    >
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
    </div>
  );
}
