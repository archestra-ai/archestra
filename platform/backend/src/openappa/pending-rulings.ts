import { LRUCacheManager } from "@/cache-manager";

const PENDING_RULINGS_TTL_MS = 15 * 60 * 1000;
const PENDING_RULINGS_MAX_SESSIONS = 5000;

/**
 * The last remedy ruling delivered to a model, per OpenAPPA session. The
 * ruling travels to the model as the get_remedy_plans result and its offers
 * pass through the model as signed claims; nothing else retains it. When the
 * model then asks the user to decide (ask_user), the answer alone is not
 * enough for weaker models to act — this store lets the ask_user result
 * repeat the ruling's exact continuation, so the next step is a concrete
 * instruction instead of a memory test.
 *
 * In-memory on purpose: it is a per-turn bridge between two tool executions
 * in the same process, not durable state.
 */
class PendingRulings {
  private readonly rulings = new LRUCacheManager<string>({
    defaultTtl: PENDING_RULINGS_TTL_MS,
    maxSize: PENDING_RULINGS_MAX_SESSIONS,
  });

  remember(params: {
    organizationId: string;
    sessionId: string;
    ruling: string;
  }): void {
    this.rulings.set(this.key(params), params.ruling);
  }

  /**
   * Return and clear the pending ruling. Consume-once: the decision it asked
   * for has been made, and a later ask_user in the same session belongs to a
   * new question.
   */
  consume(params: {
    organizationId: string;
    sessionId: string;
  }): string | undefined {
    const key = this.key(params);
    const ruling = this.rulings.get(key);
    if (ruling !== undefined) {
      this.rulings.delete(key);
    }
    return ruling;
  }

  private key(params: { organizationId: string; sessionId: string }): string {
    return `${params.organizationId}:${params.sessionId}`;
  }
}

export const pendingRulings = new PendingRulings();
