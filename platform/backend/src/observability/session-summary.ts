import { setTimeout as sleep } from "node:timers/promises";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { LRUCacheManager } from "@/cache-manager";
import type { SessionSummary } from "@/types/interaction";
import { trackBackgroundWork } from "@/utils/background-work";
import { sessionTraceId } from "./tracing/session";

/** Avoid session aggregation queries when no logger will export the summary. */
export function shouldExportSessionSummary(): boolean {
  return logs.getLogger("archestra-sessions").enabled({
    severityNumber: SeverityNumber.INFO,
    eventName: "archestra.session.summary",
  });
}

/** The session a write belongs to: its id, or the interaction when it has none. */
type SessionKey = { sessionId: string | null; interactionId: string | null };
type SummaryRow = SessionSummary & { totalDurationMs?: number | null };

/**
 * Exports a summary after each write, batching writes that arrive while an
 * export runs: one aggregation then covers all of them, instead of one query
 * per request. A quiet session still exports at once. Summaries are cumulative,
 * so a session written twice in one batch exports its latest totals once.
 *
 * Aggregating a session reads all of its requests, so a long, busy session
 * (every request carrying the same OpenAI `user`, say) would otherwise be
 * re-aggregated back to back. After each export a session rests for a
 * multiple of what its aggregation took; its latest totals export after that.
 */
export class SessionSummaryExport {
  private readonly queued = new Map<string, SessionKey>();
  /** When each recently exported session may export again. */
  private readonly resting = new LRUCacheManager<number>({
    maxSize: 10_000,
    defaultTtl: 60_000,
  });
  private running = false;

  constructor(
    private readonly summarize: (page: SessionKey[]) => Promise<SummaryRow[]>,
  ) {}

  enqueue(key: SessionKey): void {
    this.queued.set(key.sessionId ?? `interaction:${key.interactionId}`, key);
    if (this.running) return;
    this.running = true;
    trackBackgroundWork(this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued.size > 0) {
        // The session page bounds the aggregation; keep each batch that size.
        const page: [string, SessionKey][] = [];
        let wakeAt = Number.POSITIVE_INFINITY;
        for (const entry of this.queued) {
          const readyAt = this.resting.get(entry[0]);
          if (readyAt === undefined) page.push(entry);
          else wakeAt = Math.min(wakeAt, readyAt);
          if (page.length === MAX_BATCH) break;
        }
        if (page.length === 0) {
          await sleep(Math.max(1, wakeAt - Date.now()));
          continue;
        }
        for (const [id] of page) this.queued.delete(id);
        const started = performance.now();
        try {
          const rows = await this.summarize(page.map(([, key]) => key));
          for (const row of rows) exportSessionSummary(row);
        } catch {
          /* Best effort; export cannot fail a persisted request. */
        }
        const rest = Math.round(
          (performance.now() - started) * REST_PER_AGGREGATION,
        );
        if (rest > 0)
          for (const [id] of page)
            this.resting.set(id, Date.now() + rest, rest);
      }
    } finally {
      this.running = false;
    }
  }
}

/** Cumulative, persisted totals from the same aggregation as the app log list. Never sum snapshots. */
function exportSessionSummary(
  session: SessionSummary & { totalDurationMs?: number | null },
): void {
  const id = session.sessionId ?? session.interactionId;
  if (!id) return;
  // Explicit allowlist: no prompts, responses, policy text, credential values or previews.
  const body = {
    session_id: id,
    trace_id: sessionTraceId(id),
    first_request: session.firstRequestTime.toISOString(),
    last_request: session.lastRequestTime.toISOString(),
    elapsed_ms: Math.max(
      0,
      session.lastRequestTime.getTime() - session.firstRequestTime.getTime(),
    ),
    request_duration_ms: session.totalDurationMs ?? null,
    agent: session.profileName ?? "",
    agent_type: session.profileAgentType ?? "",
    user: session.userNames.join(", "),
    models: session.models.join(", "),
    source: session.sources.join(", "),
    auth_methods: session.authMethods.join(", "),
    credentials: session.virtualKeys.map((key) => key.name).join(", "),
    requests: session.requestCount,
    input_tokens: session.totalInputTokens,
    output_tokens: session.totalOutputTokens,
    cache_read_tokens: session.totalCacheReadTokens,
    cache_write_tokens: session.totalCacheWriteTokens,
    estimated_cost:
      session.totalCost === null ? null : Number(session.totalCost),
    billed_cost:
      session.totalBilledCost === null ? null : Number(session.totalBilledCost),
    subscription_cost:
      session.totalSubscriptionCost === null
        ? null
        : Number(session.totalSubscriptionCost),
  };
  try {
    logs.getLogger("archestra-sessions").emit({
      eventName: "archestra.session.summary",
      body: JSON.stringify(body),
      severityNumber: SeverityNumber.INFO,
      attributes: { event_name: "archestra.session.summary", session_id: id },
    });
  } catch {
    /* Best effort; export cannot fail a persisted request. */
  }
}

const MAX_BATCH = 100;
/** A busy session's aggregation then uses at most a fifth of the time. */
const REST_PER_AGGREGATION = 4;
