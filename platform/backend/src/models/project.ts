import { randomUUID } from "node:crypto";
import { urlSlugify } from "@archestra/shared";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import db, { schema, withDbTransaction } from "@/database";
import { notDeletedConversation } from "@/database/schemas/conversation";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import {
  findExpiredSoftDeleted,
  type HardDeleteOpts,
  hardDelete as hardDeleteRows,
  lockRowForPurge,
  restore as restoreRows,
  softDelete,
} from "@/database/soft-delete";
import { deleteRowsBytesBestEffort } from "@/skills-sandbox/file-storage";
import type { ConversationOrigin, InsertProject, Project } from "@/types";
import FileModel from "./file";
import ProjectShareModel from "./project-share";
import TaskModel from "./task";

/**
 * CRUD for `projects`. Share/visibility queries live in
 * {@link ProjectShareModel} (models/project-share.ts).
 *
 * {@link ProjectModel.delete} soft-deletes: the row is stamped `deleted_at`
 * and every read here excludes it, so the project is gone from the API. Its
 * files and scheduled tasks are RETAINED, hidden behind {@link belongsToLiveProject}
 * (and the transitive project resolution every file path performs), so a
 * restore brings them back; only the chats detach. See that method.
 */
class ProjectModel {
  static async create(project: InsertProject): Promise<Project> {
    const slug = await ProjectModel.generateUniqueSlug({
      name: project.name,
      organizationId: project.organizationId,
    });
    try {
      const [row] = await db
        .insert(schema.projectsTable)
        .values({ ...project, slug })
        .returning();
      if (!row) throw new Error("failed to insert project");
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectNameExistsError(project.name);
      }
      throw error;
    }
  }

  /**
   * Turn an existing chat into a project, atomically: create the project, move
   * the chat into it (`conversations.project_id`), and re-point the chat's
   * no-project files to the project (`files.project_id`). All in one
   * transaction so a failure leaves no orphaned project or half-moved files.
   *
   * The conversation row is locked `FOR UPDATE` so two concurrent conversions
   * of the same chat can't both create a project (the loser sees `project_id`
   * already set). The caller (service) owns eligibility/validation; this method
   * re-checks ownership and the not-already-assigned invariant under the lock.
   */
  static async createFromConversation(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
    name: string;
    description: string | null;
    icon: string | null;
  }): Promise<{ project: Project; filesMoved: number }> {
    // Computed outside the tx: `generateUniqueSlug` reads the module-level `db`,
    // and the unique index is the real guard against a slug race.
    const slug = await ProjectModel.generateUniqueSlug({
      name: params.name,
      organizationId: params.organizationId,
    });

    return db.transaction(async (tx) => {
      const [conversation] = await tx
        .select({
          id: schema.conversationsTable.id,
          projectId: schema.conversationsTable.projectId,
        })
        .from(schema.conversationsTable)
        .where(
          and(
            notDeletedConversation,
            eq(schema.conversationsTable.id, params.conversationId),
            eq(schema.conversationsTable.userId, params.userId),
            eq(schema.conversationsTable.organizationId, params.organizationId),
          ),
        )
        .for("update");
      if (!conversation) throw new ConversationNotOwnedError();
      if (conversation.projectId) throw new ProjectAlreadyAssignedError();

      let project: Project;
      try {
        const [row] = await tx
          .insert(schema.projectsTable)
          .values({
            organizationId: params.organizationId,
            userId: params.userId,
            name: params.name,
            description: params.description,
            icon: params.icon,
            slug,
          })
          .returning();
        if (!row) throw new Error("failed to insert project");
        project = row;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ProjectNameExistsError(params.name);
        }
        throw error;
      }

      await tx
        .update(schema.conversationsTable)
        .set({ projectId: project.id })
        .where(eq(schema.conversationsTable.id, params.conversationId));

      // Re-point only the caller's OWN no-project files. In a shared chat a
      // collaborator may have authored no-project files (stamped with their
      // user id); moving those into the converter's private project would strip
      // the author's access, so they stay with their author. This also makes a
      // filename clash in the brand-new project impossible: the caller's files
      // are already unique per (user, conversation, filename).
      //
      // Re-pointing leaves each row's `object_key` in place; that is correct
      // for every storage provider because reads and byte-purge address files
      // by `object_key` / row, never by folder path (so no copy, no orphaned
      // bytes). For an external store the bytes simply keep their original
      // conversation-folder layout rather than moving under the project slug.
      //
      // A file write whose scope was resolved as no-project just before this
      // runs but inserts just after stays a no-project row (still reachable in
      // the chat's own Files panel); the conversation lock does not serialize
      // file inserts. Narrow and non-destructive.
      const moved = await tx
        .update(schema.filesTable)
        .set({ projectId: project.id })
        .where(
          and(
            eq(schema.filesTable.organizationId, params.organizationId),
            eq(schema.filesTable.conversationId, params.conversationId),
            eq(schema.filesTable.userId, params.userId),
            isNull(schema.filesTable.projectId),
          ),
        )
        .returning({ id: schema.filesTable.id });

      return { project, filesMoved: moved.length };
    });
  }

  static async findById(id: string): Promise<Project | null> {
    const [row] = await db
      .select()
      .from(schema.projectsTable)
      .where(
        and(eq(schema.projectsTable.id, id), notDeleted(schema.projectsTable)),
      );
    return row ?? null;
  }

  /** Owner-scoped fetch — for mutations, which only the owner may perform. */
  static async findByIdForOwner(params: {
    id: string;
    userId: string;
    organizationId: string;
  }): Promise<Project | null> {
    const [row] = await db
      .select()
      .from(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.id, params.id),
          eq(schema.projectsTable.userId, params.userId),
          eq(schema.projectsTable.organizationId, params.organizationId),
          notDeleted(schema.projectsTable),
        ),
      );
    return row ?? null;
  }

  /**
   * Update the owner-editable fields. Only the keys present in `fields` are
   * written, so a caller can change name, description, and/or icon
   * independently. A duplicate name surfaces as {@link ProjectNameExistsError}.
   */
  static async update(params: {
    id: string;
    fields: {
      name?: string;
      description?: string | null;
      icon?: string | null;
    };
  }): Promise<void> {
    try {
      await db
        .update(schema.projectsTable)
        .set({ ...params.fields, updatedAt: new Date() })
        .where(
          and(
            eq(schema.projectsTable.id, params.id),
            notDeleted(schema.projectsTable),
          ),
        );
    } catch (error) {
      if (isUniqueViolation(error) && params.fields.name !== undefined) {
        throw new ProjectNameExistsError(params.fields.name);
      }
      throw error;
    }
  }

  /**
   * Soft delete: the project row is stamped `deleted_at` (hidden from every
   * read here, its display name freed by the partial unique index) so an
   * operator can {@link restore} it later — bringing back the share config,
   * pins, files, and scheduled tasks that all stay attached to the retained
   * row.
   *
   * What the project OWNED is RETAINED, not removed. Its files and schedules
   * keep pointing at the retained row and are hidden behind the live-project
   * guard (file access resolves the project via {@link findById}, which excludes
   * soft-deleted rows; schedules pause via {@link belongsToLiveProject}). Nothing
   * is purged, so a restore recovers them intact.
   *
   * The one exception is CHATS, which DETACH (`project_id` → NULL) and survive
   * as ordinary conversations, matching the old `ON DELETE SET NULL`. Left
   * attached they would keep rendering the deleted project's name and icon in
   * the sidebar (`ConversationModel.findAll` joins `projects`). Detach is
   * one-way: a restore does not re-adopt them, so a restored project reports
   * zero chats. Done in one transaction with the soft-delete so the two never
   * diverge.
   */
  static async delete(id: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.conversationsTable)
        .set({ projectId: null })
        .where(eq(schema.conversationsTable.projectId, id));
      await softDelete(
        tx,
        schema.projectsTable,
        eq(schema.projectsTable.id, id),
      );
    });
  }

  /**
   * Physically delete a project and everything the soft delete retained. The
   * purge paths pass `onlyIfDeletedForDays` so only an aged-out soft-deleted
   * row is removed, re-checked under FOR UPDATE so a concurrent restore wins.
   *
   * File ROWS cascade with the project, but their bytes live in the external
   * file store — collect the storage pointers inside the transaction and
   * delete the bytes after commit, so bytes never vanish for rows a rollback
   * resurrects. Schedule triggers (and their runs) cascade too; their queued
   * tasks have no FK (ids live in the payload), so they are dropped
   * explicitly or the worker keeps dequeuing work whose rows are gone. Chats
   * already detached at soft-delete (`project_id` → NULL).
   */
  static async hardDelete(id: string, opts?: HardDeleteOpts): Promise<boolean> {
    let purgeBytes: (() => Promise<void>) | null = null;
    const deleted = await withDbTransaction(async (tx) => {
      if (
        !(await lockRowForPurge(
          tx,
          schema.projectsTable,
          eq(schema.projectsTable.id, id),
          opts,
        ))
      ) {
        return false;
      }

      const triggers = await tx
        .select({ id: schema.scheduleTriggersTable.id })
        .from(schema.scheduleTriggersTable)
        .where(eq(schema.scheduleTriggersTable.projectId, id));
      for (const trigger of triggers) {
        await TaskModel.deleteQueuedForPayloadValue(
          {
            taskType: "schedule_trigger_run_execute",
            key: "triggerId",
            value: trigger.id,
          },
          tx,
        );
      }

      const files = await FileModel.listAllByProject(id, tx);
      for (const file of files) {
        await FileModel.deleteById(file.id, tx);
      }
      purgeBytes = () => deleteRowsBytesBestEffort(files);

      const count = await hardDeleteRows(
        tx,
        schema.projectsTable,
        eq(schema.projectsTable.id, id),
      );
      if (count === 0) return false;
      await opts?.onPurged?.(tx);
      return true;
    });
    if (deleted && purgeBytes) {
      await (purgeBytes as () => Promise<void>)();
    }
    return deleted;
  }

  /** The purge sweep's find-expired scan; see findExpiredSoftDeleted. */
  static async findExpiredDeleted(params: {
    retentionDays: number;
    limit: number;
  }): Promise<{ id: string; organizationId: string }[]> {
    return findExpiredSoftDeleted(
      db,
      schema.projectsTable,
      {
        id: schema.projectsTable.id,
        organizationId: schema.projectsTable.organizationId,
      },
      params,
    );
  }

  /**
   * Identity-only audit snapshot ({ id, name, deletedAt }), org-scoped,
   * soft-deleted rows included. A purge audit row records that the row is
   * gone, not what it contained.
   */
  static async findIdentityForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select({
        id: schema.projectsTable.id,
        name: schema.projectsTable.name,
        deletedAt: schema.projectsTable.deletedAt,
      })
      .from(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.id, id),
          eq(schema.projectsTable.organizationId, organizationId),
        ),
      );
    if (!row) return null;
    return { ...row, deletedAt: row.deletedAt?.toISOString() ?? null };
  }

  /**
   * Restore a soft-deleted project: clears `deleted_at` so the row (and its
   * retained files and schedules) is visible again. Org-scoped so an admin can
   * never restore across tenants. Returns false if no soft-deleted row with
   * that id exists in the org (already active, wrong org, or absent).
   *
   * Three things ride the same transaction:
   *   - The optional rename. The `(user_id, name)` index is partial on
   *     `deleted_at IS NULL`, so while the row is deleted it holds NO entry in
   *     that index and `newName` cannot collide — which is exactly why the
   *     rename must land BEFORE `deleted_at` is cleared. It is the caller's
   *     remedy when the display name was re-taken during the deleted window.
   *   - The name-collision guard. Clearing `deleted_at` re-enters the row into
   *     that index under its effective name, so the UPDATE itself can raise a
   *     unique violation — mapped to {@link ProjectNameExistsError} here,
   *     inside the tx, which is TOCTOU-safe where a pre-check `SELECT` would
   *     not be.
   *   - The forward-only schedule bump. While deleted, each trigger's
   *     `last_executed_at` froze, so `nextRun()` would resolve to a slot that
   *     passed during the deleted window and fire once on restore. Bumping every
   *     restored trigger's baseline to `now` lands the next run in the future —
   *     no catch-up burst.
   *
   * The slug is deliberately untouched by `newName`, matching {@link update}:
   * a rename never re-slugs, so the restored project keeps its own folder.
   */
  static async restore(params: {
    id: string;
    organizationId: string;
    /** The retained row's name, only for the {@link ProjectNameExistsError}. */
    name: string;
    /** Rename on the way back, to clear a name taken while it was deleted. */
    newName?: string;
  }): Promise<boolean> {
    try {
      return await db.transaction(async (tx) => {
        if (params.newName !== undefined) {
          await tx
            .update(schema.projectsTable)
            .set({ name: params.newName, updatedAt: new Date() })
            .where(
              and(
                eq(schema.projectsTable.id, params.id),
                eq(schema.projectsTable.organizationId, params.organizationId),
                isNotNull(schema.projectsTable.deletedAt),
              ),
            );
        }
        const count = await restoreRows(
          tx,
          schema.projectsTable,
          and(
            eq(schema.projectsTable.id, params.id),
            eq(schema.projectsTable.organizationId, params.organizationId),
          ),
        );
        if (count === 0) return false;
        await tx
          .update(schema.scheduleTriggersTable)
          .set({ lastExecutedAt: new Date() })
          .where(eq(schema.scheduleTriggersTable.projectId, params.id));
        return true;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectNameExistsError(params.newName ?? params.name);
      }
      throw error;
    }
  }

  /**
   * Fetch a SOFT-DELETED project by id, scoped to its org. The oversight/restore
   * counterpart to {@link findById} (which excludes soft-deleted rows). Always
   * org-scoped — never accept an id alone, or an admin could reach another
   * tenant's deleted project.
   */
  static async findDeletedByIdForOrganization(params: {
    id: string;
    organizationId: string;
  }): Promise<Project | null> {
    const [row] = await db
      .select()
      .from(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.id, params.id),
          eq(schema.projectsTable.organizationId, params.organizationId),
          isNotNull(schema.projectsTable.deletedAt),
        ),
      );
    return row ?? null;
  }

  /**
   * Audit snapshot: the project row plus its share configuration, org-scoped.
   *
   * Deliberately NOT filtered by `deleted_at` — delete and restore are the two
   * lifecycle events that most need an audit trail, and both would diff against
   * an empty snapshot on one side if soft-deleted rows were excluded. The share
   * config rides along so a visibility change (which writes `project_shares`,
   * not `projects`) still produces a non-empty diff; its id lists are sorted so
   * an unchanged audience never reads as a change.
   */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.id, id),
          eq(schema.projectsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) return null;

    const share = await ProjectShareModel.findByProjectId(id);
    return {
      ...row,
      visibility: share?.visibility ?? null,
      shareTeamIds: [...(share?.teamIds ?? [])].sort(),
      shareUserIds: [...(share?.userIds ?? [])].sort(),
    };
  }

  /** Conversation counts for a set of projects, in one grouped query. */
  static async countConversations(
    projectIds: string[],
  ): Promise<Map<string, number>> {
    if (projectIds.length === 0) return new Map();
    const rows = await db
      .select({
        projectId: schema.conversationsTable.projectId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.conversationsTable)
      .where(
        and(
          notDeletedConversation,
          inArray(schema.conversationsTable.projectId, projectIds),
        ),
      )
      .groupBy(schema.conversationsTable.projectId);
    const map = new Map<string, number>();
    for (const r of rows) {
      if (r.projectId) map.set(r.projectId, r.count);
    }
    return map;
  }

  /** All chats of one project, newest activity first, with author names. */
  static async listConversations(
    projectId: string,
    // When set, restricts the result to chats authored by this user. The
    // service passes it for callers lacking `project:read-all`, so the filter
    // runs in SQL instead of pulling every project chat into memory.
    authorUserId?: string,
  ): Promise<
    {
      id: string;
      title: string | null;
      authorUserId: string;
      authorName: string | null;
      origin: ConversationOrigin;
      lastMessageAt: Date;
      createdAt: Date;
      // The schedule + run that produced a `schedule_trigger` chat (null for
      // user chats); lets the chat list collapse a schedule's runs into one row
      // and open the latest run with its sidebar runs navigator.
      scheduleTriggerId: string | null;
      scheduleRunId: string | null;
      // The schedule's display name, shown on a collapsed scheduled chat row.
      scheduleName: string | null;
    }[]
  > {
    return (
      db
        .select({
          id: schema.conversationsTable.id,
          title: schema.conversationsTable.title,
          authorUserId: schema.conversationsTable.userId,
          authorName: schema.usersTable.name,
          origin: schema.conversationsTable.origin,
          lastMessageAt: schema.conversationsTable.lastMessageAt,
          createdAt: schema.conversationsTable.createdAt,
          scheduleTriggerId: schema.scheduleTriggerRunsTable.triggerId,
          scheduleRunId: schema.scheduleTriggerRunsTable.id,
          scheduleName: schema.scheduleTriggersTable.name,
        })
        .from(schema.conversationsTable)
        .leftJoin(
          schema.usersTable,
          eq(schema.conversationsTable.userId, schema.usersTable.id),
        )
        // 1:1 — a conversation is linked by at most one run (CAS-set), so this
        // never fans out conversation rows.
        .leftJoin(
          schema.scheduleTriggerRunsTable,
          eq(
            schema.scheduleTriggerRunsTable.chatConversationId,
            schema.conversationsTable.id,
          ),
        )
        .leftJoin(
          schema.scheduleTriggersTable,
          eq(
            schema.scheduleTriggersTable.id,
            schema.scheduleTriggerRunsTable.triggerId,
          ),
        )
        .where(
          and(
            notDeletedConversation,
            eq(schema.conversationsTable.projectId, projectId),
            authorUserId
              ? eq(schema.conversationsTable.userId, authorUserId)
              : undefined,
          ),
        )
        .orderBy(desc(schema.conversationsTable.lastMessageAt))
    );
  }

  // === internal ===

  /**
   * A URL-safe slug for the project's filesystem folder, unique within the org.
   * Derived from the name; on a base-slug collision a short random suffix keeps
   * it distinct (the unique index is the final guard against a create race).
   * Soft-deleted rows deliberately count as collisions: the retained row keeps
   * its slug so a `restore()` lands on the same folder, which means a recreated
   * same-named project must get a fresh folder of its own.
   */
  private static async generateUniqueSlug(params: {
    name: string;
    organizationId: string;
  }): Promise<string> {
    const baseSlug = urlSlugify(params.name) || "project";
    const [existing] = await db
      .select({ id: schema.projectsTable.id })
      .from(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.organizationId, params.organizationId),
          eq(schema.projectsTable.slug, baseSlug),
        ),
      )
      .limit(1);
    return existing ? `${baseSlug}-${randomUUID().slice(0, 6)}` : baseSlug;
  }
}

export default ProjectModel;

/**
 * SQL predicate for tables with a `project_id` FK: the row is project-less, or
 * its project is live (not soft-deleted). The single guard that pauses/hides
 * what a soft-deleted project owns while the rows stay attached for a restore.
 * Push it into the SQL `WHERE` (never a post-fetch JS filter), so retained rows
 * are excluded at the database and never accumulate in an in-process scan.
 */
export function belongsToLiveProject(projectIdColumn: AnyPgColumn): SQL {
  return sql`(
    ${projectIdColumn} IS NULL
    OR EXISTS (
      SELECT 1 FROM ${schema.projectsTable}
      WHERE ${schema.projectsTable.id} = ${projectIdColumn}
        AND ${schema.projectsTable.deletedAt} IS NULL
    )
  )`;
}

/** The user already has a project with this name. */
export class ProjectNameExistsError extends Error {
  constructor(name: string) {
    super(`a project named "${name}" already exists`);
    this.name = "ProjectNameExistsError";
  }
}

/** The conversation does not exist or is not owned by the caller. */
export class ConversationNotOwnedError extends Error {
  constructor() {
    super("conversation not found");
    this.name = "ConversationNotOwnedError";
  }
}

/** The conversation is already part of a project, so it can't seed a new one. */
export class ProjectAlreadyAssignedError extends Error {
  constructor() {
    super("conversation already belongs to a project");
    this.name = "ProjectAlreadyAssignedError";
  }
}

// === internal ===

/** Postgres unique_violation, as surfaced by pg and PGlite drivers. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause;
  return code === "23505" || cause?.code === "23505";
}
