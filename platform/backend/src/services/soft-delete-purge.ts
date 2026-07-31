import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { schema } from "@/database";
import logger from "@/logging";
import { AuditLogModel, DeletedItemModel, ProjectModel } from "@/models";
import { fileStore } from "@/skills-sandbox/file-store";
import type {
  AuditEventName,
  DeletedItem,
  DeletedItemEntityType,
} from "@/types";

/**
 * Who is permanently deleting. `system` is the retention sweep, which has no
 * request context — the audit middleware is request-scoped, so the sweep writes
 * its own record with this actor instead.
 */
type PurgeActor =
  | { type: "system" }
  | { type: "user"; id: string; name: string | null; email: string | null };

type PurgeOutcome =
  /** Row and bytes are gone. */
  | { status: "purged" }
  /** Restored (or already purged) between listing and the delete — left alone. */
  | { status: "skipped" }
  /**
   * A reference to this row was too large to drain within one run's budget. The
   * row keeps its `deleted_at`, so the next sweep resumes where this one
   * stopped; nothing is left half-deleted.
   */
  | { status: "deferred"; reason: string };

/**
 * Permanently delete one soft-deleted entity: reclaim its external bytes, drain
 * the references that would otherwise be rewritten inside the delete, remove the
 * row, and record that it happened.
 *
 * Shared deliberately by the retention sweep and by an admin's "Delete
 * permanently" in Deleted Items, so the two can never diverge on what "gone"
 * means.
 *
 * The order below is deliberate. Draining comes first because it is the only
 * step that can decide not to proceed, and bailing out before anything is
 * destroyed leaves the entity exactly as it was. Bytes come next, while the row
 * still points at them — after the row is gone nothing could find them again.
 * The row is last.
 */
export async function purgeDeletedItem(params: {
  item: DeletedItem;
  organizationId: string;
  actor: PurgeActor;
}): Promise<PurgeOutcome> {
  const { item, organizationId, actor } = params;

  const drain = await drainReferencesFor(item);
  if (!drain.drained) {
    logger.info(
      { entityType: item.entityType, id: item.id, reason: drain.reason },
      "soft-delete purge: deferred, reference not fully drained",
    );
    return { status: "deferred", reason: drain.reason };
  }

  await reclaimBytesFor({ item, organizationId });

  const removed = await DeletedItemModel.hardDeleteById({
    entityType: item.entityType,
    id: item.id,
    organizationId,
  });

  // Not an error: the row was restored (or purged by a concurrent run) after we
  // listed it. Its bytes are already gone, which is the one real cost of losing
  // this race — see the note on `reclaimBytesFor`.
  if (!removed) return { status: "skipped" };

  await writePurgeAuditRecord({ item, organizationId, actor });

  return { status: "purged" };
}

// ===== Internal helpers =====

/**
 * External bytes owned by the entity. Only files carry any: skill files, app
 * versions, and conversation attachments are all inline database rows, so their
 * FK cascades reclaim them when the row goes.
 *
 * This runs before the row delete and is therefore the one step a lost race
 * with a concurrent restore cannot take back. That window is narrow (the delete
 * follows immediately) and the alternative — deleting the row first — would
 * orphan every object with nothing left pointing at it, which is unrecoverable
 * rather than merely unlucky.
 */
async function reclaimBytesFor(params: {
  item: DeletedItem;
  organizationId: string;
}): Promise<void> {
  const { item, organizationId } = params;

  switch (item.entityType) {
    case "conversation": {
      // No-project files are the conversation's own: `files.conversation_id` is
      // SET NULL, so nothing would ever reclaim them after the row goes.
      await fileStore.purgeConversationFiles({
        organizationId,
        conversationId: item.id,
      });
      return;
    }
    case "project": {
      // The slug is the project's folder in the object store, so it is needed to
      // sweep hand-placed objects that never had a `files` row.
      const project = await ProjectModel.findDeletedByIdForOrganization({
        id: item.id,
        organizationId,
      });
      await fileStore.purgeProjectFiles({
        organizationId,
        projectId: item.id,
        slug: project?.slug ?? null,
      });
      return;
    }
    case "agent":
    case "app":
    case "skill":
      return;
  }
}

/**
 * Drain the `ON DELETE SET NULL` references large enough that letting Postgres
 * rewrite them inside the delete would hold locks on a write-hot table.
 *
 * Only the log-scale references are drained here. The rest
 * (`member.default_agent_id`, `app_versions.app_id`, `skill_versions.skill_id`,
 * `conversations.project_id`) are bounded by how much a person can create, so
 * the FK's own action handles them in negligible time.
 */
async function drainReferencesFor(
  item: DeletedItem,
): Promise<{ drained: true } | { drained: false; reason: string }> {
  const references = HOT_REFERENCES[item.entityType];

  for (const reference of references) {
    const { drained, nulled } = await DeletedItemModel.drainReferences({
      table: reference.table,
      column: reference.column,
      value: item.id,
      batchSize: REFERENCE_DRAIN_BATCH_SIZE,
      maxBatches: REFERENCE_DRAIN_MAX_BATCHES,
    });

    if (nulled > 0) {
      logger.info(
        { entityType: item.entityType, id: item.id, nulled, drained },
        `soft-delete purge: drained ${reference.label}`,
      );
    }

    if (!drained) {
      return {
        drained: false,
        reason: `${reference.label} still has references after ${
          REFERENCE_DRAIN_BATCH_SIZE * REFERENCE_DRAIN_MAX_BATCHES
        } rows`,
      };
    }
  }

  return { drained: true };
}

async function writePurgeAuditRecord(params: {
  item: DeletedItem;
  organizationId: string;
  actor: PurgeActor;
}): Promise<void> {
  const { item, organizationId, actor } = params;
  const now = new Date();

  try {
    await AuditLogModel.create({
      organizationId,
      occurredAt: now,
      actorId: actor.type === "user" ? actor.id : null,
      actorType: actor.type === "user" ? "user" : "system",
      actorName: actor.type === "user" ? actor.name : "Retention sweep",
      actorEmail: actor.type === "user" ? actor.email : null,
      action: PURGE_ACTIONS[item.entityType],
      outcome: "success",
      resourceType: item.entityType,
      resourceId: item.id,
      resourceName: item.name,
      // The row and its bytes are gone, so this record is the only remaining
      // evidence the entity existed; `before` carries what is still knowable
      // about it, and there is no `after` state to diff against.
      before: { name: item.name, deletedAt: item.deletedAt.toISOString() },
      after: null,
    });
  } catch (error) {
    // The purge already succeeded and is not reversible, so a failed audit write
    // must not surface as a failed purge — it would invite a retry against a row
    // that no longer exists. Log loudly instead.
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        entityType: item.entityType,
        id: item.id,
      },
      "soft-delete purge: audit record failed to write",
    );
  }
}

const PURGE_ACTIONS: Record<DeletedItemEntityType, AuditEventName> = {
  agent: "agent.purged",
  app: "app.purged",
  conversation: "conversation.purged",
  project: "project.purged",
  skill: "skill.purged",
};

/**
 * Rows per drain statement, and the cap on statements for one entity. The
 * product (500k) is the point at which a single entity is treated as too large
 * for one run and deferred to the next, so no sweep can be monopolized by one
 * pathological agent.
 */
const REFERENCE_DRAIN_BATCH_SIZE = 5_000;
const REFERENCE_DRAIN_MAX_BATCHES = 100;

type HotReference = { table: PgTable; column: PgColumn; label: string };

const HOT_REFERENCES: Record<DeletedItemEntityType, HotReference[]> = {
  agent: [
    // The one that matters: every LLM proxy call writes an interaction row, so
    // a long-lived agent accumulates them without bound.
    {
      table: schema.interactionsTable,
      column: schema.interactionsTable.profileId,
      label: "interactions.profile_id",
    },
    {
      table: schema.mcpToolCallsTable,
      column: schema.mcpToolCallsTable.agentId,
      label: "mcp_tool_calls.agent_id",
    },
    {
      table: schema.conversationsTable,
      column: schema.conversationsTable.agentId,
      label: "conversations.agent_id",
    },
  ],
  app: [
    {
      table: schema.mcpToolCallsTable,
      column: schema.mcpToolCallsTable.appId,
      label: "mcp_tool_calls.app_id",
    },
  ],
  conversation: [],
  // Soft-deleting a project already detaches its chats, so this normally finds
  // nothing. Kept because it costs one indexed lookup and covers a project whose
  // rows were soft-deleted by some other path.
  project: [
    {
      table: schema.conversationsTable,
      column: schema.conversationsTable.projectId,
      label: "conversations.project_id",
    },
  ],
  skill: [],
};
