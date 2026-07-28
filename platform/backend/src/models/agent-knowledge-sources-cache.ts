import { TimeInMs } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import { registerProcessLocalCache } from "@/process-local-cache-registry";

/**
 * Process-local cache for "does this agent have any knowledge sources?" —
 * read on every MCP gateway tools listing, which otherwise pays two
 * junction-table lookups per request on the gateway hot path. Assignment
 * writes in this process invalidate immediately; other pods converge within
 * the TTL. Staleness only affects whether the query_knowledge_sources tool is
 * surfaced (a UX affordance) — the knowledge query path itself re-checks
 * access and environment isolation.
 *
 * Lives in its own module (not on ToolModel) so the junction-table models can
 * invalidate on write without importing the tool model, which imports them.
 */
class AgentKnowledgeSourcesCache {
  private readonly cache = registerProcessLocalCache(
    new LRUCacheManager<boolean>({
      maxSize: 5000,
      defaultTtl: 30 * TimeInMs.Second,
    }),
  );

  get(agentId: string): boolean | undefined {
    return this.cache.get(agentId);
  }

  set(agentId: string, hasKnowledgeSources: boolean): void {
    this.cache.set(agentId, hasKnowledgeSources);
  }

  invalidate(agentId: string): void {
    this.cache.delete(agentId);
  }
}

export const agentKnowledgeSourcesCache = new AgentKnowledgeSourcesCache();
