import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  TaskModel,
} from "@/models";
import { agentKnowledgeSourcesCache } from "@/models/agent-knowledge-sources-cache";

/**
 * Shared soft-delete orchestration for knowledge bases and connectors.
 *
 * These functions own the cross-model *side-effects* of a delete — queued-sync
 * cancellation and knowledge-source cache invalidation — so every write surface
 * behaves identically. Both the REST routes (`routes/knowledge-base.ts`) and the
 * Archestra MCP delete tools (`archestra-mcp-server/knowledge-management.ts`)
 * call in here rather than reaching for the model `.delete()` directly; calling
 * the model alone would soft-delete the row but skip the side-effects, orphaning
 * queued syncs (which no longer self-heal via FK cascade under soft-delete) and
 * leaving the process-local cache stale.
 *
 * Deliberately NOT here:
 * - Authorization — stays at each entry point (route / MCP handler), including
 *   the enterprise `auto-sync-permissions` check.
 * - Secret revocation — deferred to the purge / hard-delete follow-up. Keeping
 *   the secret makes a future restore credential-preserving (no re-auth).
 *
 * Un-transactioned, mirroring the pre-soft-delete route: the only inter-step
 * failure (queued syncs cancelled, then `softDelete` fails) self-heals via cron
 * re-enqueue, and cache invalidation runs post-commit regardless.
 */

/**
 * Soft-delete a connector and run its teardown side-effects. Returns false when
 * no active connector matched (already deleted / unknown id), which callers
 * surface as a 404.
 */
export async function deleteConnector(connectorId: string): Promise<boolean> {
  // Capture the affected agents BEFORE stamping deleted_at. findByConnector is
  // an unfiltered junction read, but capturing up front means invalidation
  // never depends on it staying unfiltered.
  const assignments =
    await AgentConnectorAssignmentModel.findByConnector(connectorId);

  // Cancel queued/scheduled sync work first so nothing new runs against the
  // connector. Under soft-delete the run rows are not cascade-removed, so the
  // old "run stops when its run row disappears" self-heal no longer applies —
  // these tasks would otherwise orphan and head-of-line-block other connectors.
  await TaskModel.deleteQueuedForConnector(connectorId);

  const deleted = await KnowledgeBaseConnectorModel.delete(connectorId);

  if (deleted) {
    for (const agentId of new Set(assignments.map((a) => a.agentId))) {
      agentKnowledgeSourcesCache.invalidate(agentId);
    }
  }

  return deleted;
}

/**
 * Soft-delete a knowledge base and invalidate the knowledge-source cache for
 * every agent it was assigned to. Returns false when no active KB matched.
 *
 * A KB has no queued-sync side-effect of its own (syncs are per-connector, and
 * a KB's connectors are separate entities reached through the junction), so the
 * only teardown is cache invalidation.
 */
export async function deleteKnowledgeBase(
  knowledgeBaseId: string,
): Promise<boolean> {
  // Capture affected agents before the stamp (findByKnowledgeBase keys on the
  // KB id, so it returns the assignments regardless of the KB's own state).
  const assignments =
    await AgentKnowledgeBaseModel.findByKnowledgeBase(knowledgeBaseId);

  const deleted = await KnowledgeBaseModel.delete(knowledgeBaseId);

  if (deleted) {
    for (const agentId of new Set(assignments.map((a) => a.agentId))) {
      agentKnowledgeSourcesCache.invalidate(agentId);
    }
  }

  return deleted;
}
