import { Cron } from "croner";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type {
  InsertScheduleTrigger,
  ScheduleTrigger,
  UpdateScheduleTrigger,
} from "@/types";
import { InsertScheduleTriggerSchema } from "@/types";
import {
  normalizeCronExpression,
  normalizeTimezone,
} from "@/utils/schedule-trigger";
import { escapeLikePattern } from "@/utils/sql-search";
import { belongsToLiveProject } from "./project";

type ScheduleTriggerListFilters = {
  organizationId: string;
  limit?: number;
  offset?: number;
  enabled?: boolean;
  agentIds?: string[];
  actorUserId?: string;
  actorUserIds?: string[];
  excludeActorUserId?: string;
  name?: string;
  projectId?: string;
};

class ScheduleTriggerModel {
  static async countByOrganization(
    params: Pick<
      ScheduleTriggerListFilters,
      | "organizationId"
      | "enabled"
      | "agentIds"
      | "actorUserId"
      | "actorUserIds"
      | "excludeActorUserId"
      | "name"
      | "projectId"
    >,
  ): Promise<number> {
    const filters = buildListFilters(params);
    if (!filters) return 0;

    const [result] = await db
      .select({ count: count() })
      .from(schema.scheduleTriggersTable)
      .where(and(...filters));

    return result?.count ?? 0;
  }

  static async listByOrganization(
    params: ScheduleTriggerListFilters,
  ): Promise<ScheduleTrigger[]> {
    const filters = buildListFilters(params);
    if (!filters) return [];

    let query = db
      .select({
        ...triggerColumns(),
        actor: actorColumns(),
        agent: agentColumns(),
      })
      .from(schema.scheduleTriggersTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.scheduleTriggersTable.actorUserId, schema.usersTable.id),
      )
      .innerJoin(
        schema.agentsTable,
        and(
          eq(schema.scheduleTriggersTable.agentId, schema.agentsTable.id),
          notDeleted(schema.agentsTable),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(schema.scheduleTriggersTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }

    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findById(id: string): Promise<ScheduleTrigger | null> {
    const [trigger] = await db
      .select({
        ...triggerColumns(),
        actor: actorColumns(),
        agent: agentColumns(),
      })
      .from(schema.scheduleTriggersTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.scheduleTriggersTable.actorUserId, schema.usersTable.id),
      )
      .innerJoin(
        schema.agentsTable,
        and(
          eq(schema.scheduleTriggersTable.agentId, schema.agentsTable.id),
          notDeleted(schema.agentsTable),
        ),
      )
      .where(eq(schema.scheduleTriggersTable.id, id));

    return trigger ?? null;
  }

  static async create(data: InsertScheduleTrigger): Promise<ScheduleTrigger> {
    const parsed = InsertScheduleTriggerSchema.parse(data);
    const [created] = await db
      .insert(schema.scheduleTriggersTable)
      .values({
        ...parsed,
        cronExpression:
          parsed.cronExpression != null
            ? normalizeCronExpression(parsed.cronExpression)
            : null,
        timezone: normalizeTimezone(parsed.timezone),
      })
      .returning();

    return (await ScheduleTriggerModel.findById(created.id)) ?? created;
  }

  static async update(
    id: string,
    data: Partial<UpdateScheduleTrigger>,
  ): Promise<ScheduleTrigger | null> {
    const [updated] = await db
      .update(schema.scheduleTriggersTable)
      .set({
        ...data,
        ...(data.cronExpression !== undefined && {
          cronExpression:
            data.cronExpression != null
              ? normalizeCronExpression(data.cronExpression)
              : null,
        }),
        ...(data.timezone !== undefined && {
          timezone: normalizeTimezone(data.timezone),
        }),
      })
      .where(eq(schema.scheduleTriggersTable.id, id))
      .returning({ id: schema.scheduleTriggersTable.id });

    if (!updated) {
      return null;
    }

    return await ScheduleTriggerModel.findById(updated.id);
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.scheduleTriggersTable)
      .where(eq(schema.scheduleTriggersTable.id, id));

    return (result.rowCount ?? 0) > 0;
  }

  static async findDueTriggers(now: Date): Promise<ScheduleTrigger[]> {
    const enabledTriggers = await db
      .select({
        ...triggerColumns(),
        actor: actorColumns(),
        agent: agentColumns(),
      })
      .from(schema.scheduleTriggersTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.scheduleTriggersTable.actorUserId, schema.usersTable.id),
      )
      .innerJoin(
        schema.agentsTable,
        and(
          eq(schema.scheduleTriggersTable.agentId, schema.agentsTable.id),
          notDeleted(schema.agentsTable),
        ),
      )
      .where(
        and(
          eq(schema.scheduleTriggersTable.enabled, true),
          // A soft-deleted project pauses its scheduled tasks: the trigger row
          // is retained (hidden with the project) but never picked up — the
          // same stance as the notDeleted(agents) join above. Filtered in SQL,
          // so hidden triggers never enter the fetch-and-iterate set below.
          belongsToLiveProject(schema.scheduleTriggersTable.projectId),
        ),
      );

    const dueTriggers: ScheduleTrigger[] = [];
    for (const trigger of enabledTriggers) {
      // One-shot triggers (`runAt`, no cron): due once their time has passed
      // and they have never fired. They must not fall through to the cron
      // branch — its catch would silently skip a null expression forever.
      if (trigger.runAt !== null) {
        if (trigger.lastExecutedAt === null && trigger.runAt <= now) {
          dueTriggers.push(trigger);
        }
        continue;
      }
      if (trigger.cronExpression === null) {
        // Unreachable under the cron-or-run-at CHECK; never silently skip.
        continue;
      }
      try {
        const cron = new Cron(normalizeCronExpression(trigger.cronExpression), {
          mode: "5-part",
          paused: true,
          timezone: normalizeTimezone(trigger.timezone),
        });
        const from = trigger.lastExecutedAt ?? trigger.createdAt;
        const nextRun = cron.nextRun(from);
        if (nextRun && nextRun <= now) {
          dueTriggers.push(trigger);
        }
      } catch {
        // Skip triggers with invalid cron expressions
      }
    }

    return dueTriggers;
  }

  /**
   * Wakeup triggers targeting a chat conversation, newest first. Scoped to
   * the actor who created them — the same caller-owns-it rule as background
   * tasks.
   */
  static async listForConversation(params: {
    conversationId: string;
    actorUserId: string;
  }): Promise<ScheduleTrigger[]> {
    return db
      .select()
      .from(schema.scheduleTriggersTable)
      .where(
        and(
          eq(
            schema.scheduleTriggersTable.conversationId,
            params.conversationId,
          ),
          eq(schema.scheduleTriggersTable.actorUserId, params.actorUserId),
        ),
      )
      .orderBy(desc(schema.scheduleTriggersTable.createdAt));
  }

  /**
   * Delete a wakeup trigger the caller owns on the given conversation, in one
   * guarded statement — the (conversation, actor) match IS the authorization,
   * mirroring cancelForPrincipal on background tasks.
   */
  static async deleteForConversationActor(params: {
    id: string;
    conversationId: string;
    actorUserId: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(schema.scheduleTriggersTable)
      .where(
        and(
          eq(schema.scheduleTriggersTable.id, params.id),
          eq(
            schema.scheduleTriggersTable.conversationId,
            params.conversationId,
          ),
          eq(schema.scheduleTriggersTable.actorUserId, params.actorUserId),
        ),
      )
      .returning({ id: schema.scheduleTriggersTable.id });
    return deleted.length > 0;
  }

  /** Enabled wakeup triggers on a conversation (the per-conversation cap). */
  static async countEnabledForConversation(
    conversationId: string,
  ): Promise<number> {
    const rows = await db
      .select({ id: schema.scheduleTriggersTable.id })
      .from(schema.scheduleTriggersTable)
      .where(
        and(
          eq(schema.scheduleTriggersTable.conversationId, conversationId),
          eq(schema.scheduleTriggersTable.enabled, true),
        ),
      );
    return rows.length;
  }

  static async markExecuted(id: string, now: Date): Promise<void> {
    await db
      .update(schema.scheduleTriggersTable)
      .set({ lastExecutedAt: now })
      .where(eq(schema.scheduleTriggersTable.id, id));
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const trigger = await ScheduleTriggerModel.findById(id);
    if (!trigger || trigger.organizationId !== organizationId) return null;

    return {
      id: trigger.id,
      name: trigger.name,
      agentId: trigger.agentId,
      agentName: trigger.agent?.name ?? null,
      messageTemplate: trigger.messageTemplate,
      cronExpression: trigger.cronExpression,
      timezone: trigger.timezone,
      enabled: trigger.enabled,
      actorUserId: trigger.actorUserId,
      lastExecutedAt: trigger.lastExecutedAt?.toISOString() ?? null,
      createdAt: trigger.createdAt.toISOString(),
    };
  }
}

export default ScheduleTriggerModel;

function buildListFilters(
  params: Pick<
    ScheduleTriggerListFilters,
    | "organizationId"
    | "enabled"
    | "agentIds"
    | "actorUserId"
    | "actorUserIds"
    | "excludeActorUserId"
    | "name"
    | "projectId"
  >,
): SQL[] | null {
  if (
    (params.agentIds !== undefined && params.agentIds.length === 0) ||
    (params.actorUserIds !== undefined && params.actorUserIds.length === 0)
  ) {
    return null;
  }

  const filters: SQL[] = [
    eq(schema.scheduleTriggersTable.organizationId, params.organizationId),
    sql`EXISTS (
      SELECT 1 FROM ${schema.agentsTable}
      WHERE ${schema.agentsTable.id} = ${schema.scheduleTriggersTable.agentId}
        AND ${schema.agentsTable.deletedAt} IS NULL
    )`,
    // Triggers of a soft-deleted project are hidden with it, like the deleted
    // agents above. Direct-by-id access (incl. run-now) is closed off separately
    // in `findAccessibleTriggerOrThrow` (routes/schedule-trigger.ts).
    belongsToLiveProject(schema.scheduleTriggersTable.projectId),
  ];

  if (params.enabled !== undefined) {
    filters.push(eq(schema.scheduleTriggersTable.enabled, params.enabled));
  }

  if (params.agentIds !== undefined && params.agentIds.length > 0) {
    filters.push(
      inArray(schema.scheduleTriggersTable.agentId, params.agentIds),
    );
  }

  if (params.actorUserId !== undefined) {
    filters.push(
      eq(schema.scheduleTriggersTable.actorUserId, params.actorUserId),
    );
  }

  if (params.actorUserIds !== undefined && params.actorUserIds.length > 0) {
    filters.push(
      inArray(schema.scheduleTriggersTable.actorUserId, params.actorUserIds),
    );
  }

  if (params.excludeActorUserId !== undefined) {
    filters.push(
      ne(schema.scheduleTriggersTable.actorUserId, params.excludeActorUserId),
    );
  }

  if (params.name) {
    filters.push(
      ilike(
        schema.scheduleTriggersTable.name,
        `%${escapeLikePattern(params.name)}%`,
      ),
    );
  }

  if (params.projectId !== undefined) {
    filters.push(eq(schema.scheduleTriggersTable.projectId, params.projectId));
  }

  return filters;
}

function triggerColumns() {
  return {
    id: schema.scheduleTriggersTable.id,
    organizationId: schema.scheduleTriggersTable.organizationId,
    name: schema.scheduleTriggersTable.name,
    agentId: schema.scheduleTriggersTable.agentId,
    projectId: schema.scheduleTriggersTable.projectId,
    messageTemplate: schema.scheduleTriggersTable.messageTemplate,
    cronExpression: schema.scheduleTriggersTable.cronExpression,
    runAt: schema.scheduleTriggersTable.runAt,
    conversationId: schema.scheduleTriggersTable.conversationId,
    timezone: schema.scheduleTriggersTable.timezone,
    quiet: schema.scheduleTriggersTable.quiet,
    enabled: schema.scheduleTriggersTable.enabled,
    actorUserId: schema.scheduleTriggersTable.actorUserId,
    lastExecutedAt: schema.scheduleTriggersTable.lastExecutedAt,
    createdAt: schema.scheduleTriggersTable.createdAt,
  };
}

function actorColumns() {
  return {
    id: schema.usersTable.id,
    name: schema.usersTable.name,
    email: schema.usersTable.email,
  };
}

function agentColumns() {
  return {
    id: schema.agentsTable.id,
    name: schema.agentsTable.name,
    agentType: schema.agentsTable.agentType,
  };
}
