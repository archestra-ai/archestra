import {
  type AgentRuntimeError,
  type AgentRuntimeEvent,
  AgentRuntimeEventSchema,
  type AgentRuntimeState,
  AgentRuntimeStateSchema,
  formatAgentRuntimeError,
} from "@archestra/shared";
import { z } from "zod";
import logger from "@/logging";
import type { AgentRunAttentionState } from "@/types/agent-runtime";

const MAX_READ_BYTES = 512 * 1024;
const MAX_EVENTS_PER_READ = 100;
// The image caps each journal at 1,000 records, including its terminal slot.
const MAX_BATCHES_PER_POLL = 10;
const MAX_SEEN_EVENT_IDS = 1024;

const RuntimeEventReadResponseSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string().uuid(),
    attemptId: z.string().uuid(),
    events: z.array(AgentRuntimeEventSchema).max(MAX_EVENTS_PER_READ),
    nextSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    hasMore: z.boolean(),
  })
  .strict();

type RuntimeEventReadResponse = z.infer<typeof RuntimeEventReadResponseSchema>;

type RuntimeEventStateSink = (params: {
  taskId: string;
  state: AgentRuntimeState;
  attentionState: AgentRunAttentionState | null;
}) => Promise<boolean>;

type RuntimeEventReader = (params: {
  afterSequence: number;
}) => Promise<string>;

type RuntimeEventMonitorOptions = {
  taskId: string;
  attemptId: string;
  runId: string;
  read: RuntimeEventReader;
  persist: RuntimeEventStateSink;
  initialState?: AgentRuntimeState | null;
  initialAttentionState?: AgentRunAttentionState | null;
};

type RuntimeEventMonitorResult = {
  accepted: number;
  hasMore: boolean;
  unavailable: boolean;
};

/**
 * Consumes the bounded event reader exposed by an Agent Runtime image.
 *
 * This is deliberately a monitor, not a task lifecycle. It can persist
 * advisory state and diagnostics, but it never settles an A2A task. The
 * existing completion bridge remains the only source of the terminal result.
 */
export class AgentRuntimeEventMonitor {
  private readonly options: RuntimeEventMonitorOptions;
  private activity: AgentRuntimeState["activity"];
  private diagnostic: AgentRuntimeError | null;
  private outcome: AgentRuntimeState["outcome"];
  private attentionState: AgentRunAttentionState | null;
  private afterSequence: number;
  private readonly seenEventIds = new Set<string>();
  private unavailable = false;
  private protocolError = false;
  private terminalFailure: AgentRuntimeError | null = null;

  constructor(options: RuntimeEventMonitorOptions) {
    this.options = options;
    this.activity = options.initialState?.activity ?? "unknown";
    this.diagnostic = options.initialState?.diagnostic ?? null;
    this.outcome = options.initialState?.outcome ?? null;
    this.terminalFailure = this.outcome === "failed" ? this.diagnostic : null;
    this.attentionState = options.initialAttentionState ?? null;
    this.afterSequence = options.initialState?.sequence ?? 0;
    if (options.initialState?.eventId)
      this.seenEventIds.add(options.initialState.eventId);
  }

  get latestFailure(): AgentRuntimeError | null {
    return this.terminalFailure;
  }

  /** Prefer the native cause through the existing process-exit completion path. */
  failureReasonForExit(): string | null {
    return this.terminalFailure
      ? formatAgentRuntimeError(this.terminalFailure)
      : null;
  }

  async poll(): Promise<RuntimeEventMonitorResult> {
    if (this.protocolError)
      return { accepted: 0, hasMore: false, unavailable: true };

    let accepted = 0;
    let hasMore = false;
    for (let batch = 0; batch < MAX_BATCHES_PER_POLL; batch += 1) {
      let response: RuntimeEventReadResponse;
      try {
        const raw = await this.options.read({
          afterSequence: this.afterSequence,
        });
        if (Buffer.byteLength(raw, "utf8") > MAX_READ_BYTES)
          throw new Error("runtime event response exceeded its byte limit");
        const parsed = RuntimeEventReadResponseSchema.safeParse(
          JSON.parse(raw),
        );
        if (!parsed.success) throw new Error("invalid runtime event response");
        response = parsed.data;
      } catch (error) {
        if (!this.unavailable)
          logger.warn(
            {
              reason: describeEventReaderFailure(error),
              taskId: this.options.taskId,
              runId: this.options.runId,
              attemptId: this.options.attemptId,
            },
            "Agent Runtime event reader is unavailable; completion monitoring will continue",
          );
        this.unavailable = true;
        return { accepted, hasMore: false, unavailable: true };
      }

      this.unavailable = false;

      if (
        response.taskId !== this.options.taskId ||
        response.attemptId !== this.options.attemptId
      ) {
        this.protocolError = true;
        logger.warn(
          {
            taskId: this.options.taskId,
            runId: this.options.runId,
            attemptId: this.options.attemptId,
            responseTaskId: response.taskId,
            responseAttemptId: response.attemptId,
          },
          "Rejected Agent Runtime events for a different task or attempt",
        );
        return { accepted, hasMore: false, unavailable: true };
      }

      let previousSequence = this.afterSequence;
      for (const event of response.events) {
        if (
          event.taskId !== this.options.taskId ||
          event.attemptId !== this.options.attemptId
        ) {
          this.protocolError = true;
          logger.warn(
            {
              taskId: this.options.taskId,
              runId: this.options.runId,
              attemptId: this.options.attemptId,
              eventTaskId: event.taskId,
              eventAttemptId: event.attemptId,
            },
            "Rejected an Agent Runtime event for a different task or attempt",
          );
          return { accepted, hasMore: false, unavailable: true };
        }
        if (event.sequence <= this.afterSequence) continue;
        if (event.sequence <= previousSequence) {
          this.protocolError = true;
          logger.warn(
            {
              taskId: this.options.taskId,
              runId: this.options.runId,
              attemptId: this.options.attemptId,
              sequence: event.sequence,
            },
            "Rejected out-of-order Agent Runtime events",
          );
          return { accepted, hasMore: false, unavailable: true };
        }
        previousSequence = event.sequence;
        if (this.seenEventIds.has(event.eventId)) continue;

        const next = this.reduce(event);
        const persisted = AgentRuntimeStateSchema.safeParse(next.state);
        if (!persisted.success) {
          this.protocolError = true;
          logger.warn(
            { taskId: this.options.taskId, runId: this.options.runId },
            "Rejected an invalid Agent Runtime state",
          );
          return { accepted, hasMore: false, unavailable: true };
        }
        try {
          // A false result means the durable row was already closed or won by
          // a newer state. Advance the local cursor so a late callback cannot
          // keep a monitor hot forever; the task lifecycle still owns CAS.
          await this.options.persist({
            taskId: this.options.taskId,
            state: persisted.data,
            attentionState: next.attentionState,
          });
        } catch (error) {
          logger.warn(
            {
              error,
              taskId: this.options.taskId,
              runId: this.options.runId,
              attemptId: this.options.attemptId,
              sequence: event.sequence,
            },
            "Could not persist Agent Runtime event state; will retry",
          );
          return { accepted, hasMore: true, unavailable: false };
        }

        this.activity = next.state.activity;
        this.diagnostic = next.state.diagnostic;
        this.outcome = next.state.outcome;
        this.attentionState = next.attentionState;
        this.afterSequence = event.sequence;
        this.remember(event.eventId);
        accepted += 1;
        logger.info(
          {
            taskId: this.options.taskId,
            runId: this.options.runId,
            attemptId: this.options.attemptId,
            eventId: event.eventId,
            sequence: event.sequence,
            source: event.source,
            type: event.type,
            ...(event.type === "agent.status"
              ? { status: event.status, attention: event.attention }
              : "error" in event
                ? { code: event.error.code, phase: event.error.phase }
                : { outcome: event.outcome }),
          },
          "Accepted Agent Runtime event",
        );
      }

      hasMore = response.hasMore;
      if (!response.hasMore || response.events.length === 0) break;
    }
    return { accepted, hasMore, unavailable: false };
  }

  private reduce(event: AgentRuntimeEvent): {
    state: AgentRuntimeState;
    attentionState: AgentRunAttentionState | null;
  } {
    let activity = this.activity;
    let diagnostic = this.diagnostic;
    let attentionState = this.attentionState;
    let outcome = this.outcome;
    // A terminal native outcome survives later advisory hooks and recovery.
    if (outcome === null && event.type === "agent.status") {
      activity = event.status;
      // Idle is advisory and must not erase an explicit native auth/input
      // request. Native callbacks remain responsible for clearing attention.
      if (isHerdrAdvisory(event.source)) {
        if (!attentionState && event.attention)
          attentionState = event.attention;
      } else {
        attentionState = event.attention;
        if (event.status === "working" && event.attention === null)
          diagnostic = null;
      }
    } else if (outcome === null && event.type === "diagnostic") {
      diagnostic = event.error;
    } else if (outcome === null && event.type === "turn.finished") {
      activity = "idle";
      outcome = event.outcome;
      diagnostic = event.outcome === "failed" ? event.error : null;
      if (event.outcome === "failed") this.terminalFailure = event.error;
    }
    return {
      state: {
        version: 1,
        attemptId: this.options.attemptId,
        sequence: event.sequence,
        eventId: event.eventId,
        source: event.source,
        observedAt: event.observedAt,
        activity,
        outcome,
        diagnostic,
      },
      attentionState,
    };
  }

  private remember(eventId: string): void {
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size <= MAX_SEEN_EVENT_IDS) return;
    const oldest = this.seenEventIds.values().next().value as
      | string
      | undefined;
    if (oldest) this.seenEventIds.delete(oldest);
  }
}

function isHerdrAdvisory(source: string): boolean {
  return source === "herdr" || source.startsWith("herdr.");
}

function describeEventReaderFailure(error: unknown): string {
  if (error instanceof SyntaxError) return "malformed_json";
  if (error instanceof Error && error.message.includes("byte limit"))
    return "response_too_large";
  if (
    error instanceof Error &&
    error.message.includes("runtime event response")
  )
    return "invalid_response";
  return "reader_unavailable";
}
