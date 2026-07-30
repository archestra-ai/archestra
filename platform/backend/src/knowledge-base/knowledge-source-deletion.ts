import logger from "@/logging";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  TaskModel,
} from "@/models";
import { agentKnowledgeSourcesCache } from "@/models/agent-knowledge-sources-cache";
import { secretManager } from "@/secrets-manager";

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
 * - The physical child cascade (documents, chunks, ACLs, runs) — deferred to
 *   the purge follow-up. Those rows are unreachable meanwhile: every resolver
 *   is `notDeleted()`-filtered.
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
  // Both reads happen BEFORE the stamp, while `notDeleted()`-filtered resolvers
  // still see the connector: the assignment set drives cache invalidation, and
  // the row carries the secret to revoke. Capturing up front also means neither
  // depends on a resolver staying unfiltered.
  const [connector, assignments] = await Promise.all([
    KnowledgeBaseConnectorModel.findById(connectorId),
    AgentConnectorAssignmentModel.findByConnector(connectorId),
  ]);

  // Cancel queued/scheduled sync work first so nothing new runs against the
  // connector. Under soft-delete the run rows are not cascade-removed, so the
  // old "run stops when its run row disappears" self-heal no longer applies —
  // these tasks would otherwise orphan and head-of-line-block other connectors.
  await TaskModel.deleteQueuedForConnector(connectorId);

  // ...and stop the runs already in flight. Same lost self-heal: their lease no
  // longer fails on its own, so without this an executing sync would keep
  // pulling from the upstream source and writing documents for a connector the
  // user just deleted.
  await ConnectorRunModel.supersedeRunningForConnector(connectorId);

  const deleted = await KnowledgeBaseConnectorModel.delete(connectorId);

  if (deleted) {
    for (const agentId of new Set(assignments.map((a) => a.agentId))) {
      agentKnowledgeSourcesCache.invalidate(agentId);
    }
    await revokeConnectorSecret(connector?.secretId ?? null);
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

// ===== Internal =====

/**
 * Destroy the connector's stored credential, exactly as the hard delete did.
 *
 * Soft delete must NOT keep it: deleting a connector is how an admin cuts the
 * platform's access to the upstream source, and once the row is stamped the
 * connector 404s from every route, so the secret could never be rotated or
 * revoked afterwards — there is no list/delete secret endpoint. A restored
 * connector re-authenticates instead, which is the safe direction.
 *
 * Best-effort, mirroring the pre-soft-delete route: a secret-store failure is
 * logged, never fatal to the delete. `secret_id` is `ON DELETE SET NULL`, so
 * the connector row is left with no dangling reference.
 */
async function revokeConnectorSecret(secretId: string | null): Promise<void> {
  if (!secretId) return;

  try {
    await secretManager().deleteSecret(secretId);
  } catch (error) {
    logger.warn(
      {
        secretId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[Connector] Failed to delete connector secret",
    );
  }
}
