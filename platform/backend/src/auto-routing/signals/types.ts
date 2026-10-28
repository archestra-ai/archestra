import type { ScorerSpec } from "./spec";

/** What a pre-run source sees of a new session: its opening and the client's metadata. */
export interface PreRunInput {
  firstUserText: string;
  client: string | null;
}

export interface SignalSourceContext {
  organizationId: string;
  /** Overrides the live-routing scorer timeout, for callers no request waits on. */
  timeoutMs?: number;
}

/**
 * A signal read before the session runs. `id` keys the source's signal in a
 * decision's features; its version is the scorer-version row of `spec`, so any
 * spec edit makes earlier history and plans unusable for it.
 */
export interface PreRunSignalSource<Id extends string, Reading> {
  readonly id: Id;
  readonly spec: ScorerSpec;
  read(input: PreRunInput, ctx: SignalSourceContext): Promise<Reading>;
}

type SignalSourceErrorReason =
  | "timeout"
  | "http"
  | "invalid_response"
  | "no_credentials";

export class SignalSourceError extends Error {
  readonly reason: SignalSourceErrorReason;
  readonly status: number | undefined;

  constructor(
    reason: SignalSourceErrorReason,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "SignalSourceError";
    this.reason = reason;
    this.status = options?.status;
  }
}
