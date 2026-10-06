import { AsyncLocalStorage } from "node:async_hooks";
import type { OfferJws } from "./offer-claims";
import type { OpenAppaSession } from "./service";

/**
 * A host pause recorded only after execute_remedy_plan has selected a plan
 * and the policy requires a person. The sink is installed by in-process
 * ChatOps and private email, never by web Chat, MCP, or a system actor.
 */
export type DurableReviewPause = {
  offerId: string;
  toolCallId?: string;
  toolName?: string;
  jws: OfferJws;
  remedyArguments: Record<string, unknown>;
  session: OpenAppaSession;
};

type Sink = {
  pauses: DurableReviewPause[];
};

const storage = new AsyncLocalStorage<Sink>();

export function durableReviewActive(): boolean {
  return storage.getStore() !== undefined;
}

export function noteDurableReview(pause: DurableReviewPause): void {
  storage.getStore()?.pauses.push(pause);
}

export function durableReviewPauses(): readonly DurableReviewPause[] {
  return storage.getStore()?.pauses ?? [];
}

/**
 * Scope the sink to this run only. A finished or failed run restores the
 * caller's store; it does not disable stores belonging to other turns.
 */
export async function runWithDurableReview<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; pauses: readonly DurableReviewPause[] }> {
  const sink: Sink = { pauses: [] };
  const result = await storage.run(sink, fn);
  return { result, pauses: sink.pauses };
}

/** A child/headless run must not inherit the caller's human-review sink. */
export function runWithoutDurableReview<T>(fn: () => Promise<T>): Promise<T> {
  return storage.exit(fn);
}
