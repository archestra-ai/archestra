import type { SessionKind } from "@/routes/proxy/utils/headers/session-metadata";
import type { ScorerSpec } from "./spec";

export interface ScorerInput {
  firstUserText: string;
  kind: SessionKind;
  client: string | null;
}

export interface ScorerContext {
  organizationId: string;
  signal: AbortSignal;
}

export interface ScorerResult {
  /** Distribution of the weakest adequate tier: (fast, normal, smart), sums to 1. */
  tierNeeded: [number, number, number];
  /** Probability that the session's context grows past the long-context threshold. */
  pLong: number;
  /** Upstream-reported cost of the scoring call, when the endpoint reports one. */
  costUsd: number | null;
}

export interface SessionScorer {
  readonly spec: ScorerSpec;
  score(input: ScorerInput, ctx: ScorerContext): Promise<ScorerResult>;
}

type ScorerErrorReason =
  | "timeout"
  | "http"
  | "invalid_response"
  | "no_credentials";

export class ScorerError extends Error {
  readonly reason: ScorerErrorReason;
  readonly status: number | undefined;

  constructor(
    reason: ScorerErrorReason,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ScorerError";
    this.reason = reason;
    this.status = options?.status;
  }
}
