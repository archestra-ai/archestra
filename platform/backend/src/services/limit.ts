import { TimeInMs } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import AgentModel from "@/models/agent";
import LimitModel from "@/models/limit";
import { ApiError } from "@/types";
import type { CreateLimit, LimitEntityType, LimitType } from "@/types/limit";

export async function createLimit(data: CreateLimit) {
  if (data.entityType === "agent" && data.limitType === "token_cost") {
    const agent = await AgentModel.findById(data.entityId);
    if (agent?.agentType === "llm_proxy") {
      throw new ApiError(
        400,
        "LLM Proxy cost limits are no longer supported. Use an organization limit instead.",
      );
    }
  }
  return LimitModel.create(data);
}

/**
 * Resets elapsed limit windows before a limit read reports usage, at most
 * once per {@link READ_CLEANUP_INTERVAL_MS} per selection in this process,
 * since pages poll limits every few seconds. Enforcement does not rely on it:
 * the LLM proxy resets a request's own limits before checking them.
 */
class LimitReadCleanup {
  private readonly lastRuns = new LRUCacheManager<true>({
    maxSize: 1_000,
    defaultTtl: READ_CLEANUP_INTERVAL_MS,
  });

  async run(options: {
    organizationId: string;
    entityType?: LimitEntityType;
    entityId?: string;
    limitType?: LimitType;
  }): Promise<void> {
    const key = [
      options.organizationId,
      options.entityType ?? "",
      options.entityId ?? "",
      options.limitType ?? "",
    ].join(":");
    if (this.lastRuns.get(key)) return;
    this.lastRuns.set(key, true);
    try {
      await LimitModel.cleanupLimitsIfNeeded({
        allForOrganizationId: options.organizationId,
        entityType: options.entityType,
        entityId: options.entityId,
        limitType: options.limitType,
      });
    } catch (error) {
      // A failed cleanup must not hold off the next read's attempt.
      this.lastRuns.delete(key);
      throw error;
    }
  }
}

const READ_CLEANUP_INTERVAL_MS = 30 * TimeInMs.Second;

export const limitReadCleanup = new LimitReadCleanup();
