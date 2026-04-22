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
} from "drizzle-orm";
import db, { schema } from "@/database";
import {
  normalizeCronExpression,
  normalizeTimezone,
} from "@/schedule-triggers/utils";
import type {
  InsertScheduleTrigger,
  ScheduleTrigger,
  UpdateScheduleTrigger,
} from "@/types";
import { InsertScheduleTriggerSchema } from "@/types";

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
      .leftJoin(
        schema.agentsTable,
        eq(schema.scheduleTriggersTable.agentId, schema.agentsTable.id),
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
      .leftJoin(
        schema.agentsTable,
        eq(schema.scheduleTriggersTable.agentId, schema.agentsTable.id),
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
        cronExpression: normalizeCronExpression(parsed.cronExpression),
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
          cronExpression: normalizeCronExpression(data.cronExpression),
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
      .leftJoin(
        schema.agentsTable,
        eq(schema.scheduleTriggersTable.agentId, schema.agentsTable.id),
      )
      .where(eq(schema.scheduleTriggersTable.enabled, true));

    const dueTriggers: ScheduleTrigger[] = [];
    for (const trigger of enabledTriggers) {
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

  static async markExecuted(id: string, now: Date): Promise<void> {
    await db
      .update(schema.scheduleTriggersTable)
      .set({ lastExecutedAt: now })
      .where(eq(schema.scheduleTriggersTable.id, id));
  }
}

export default ScheduleTriggerModel;

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

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

  return filters;
}

function triggerColumns() {
  return {
    id: schema.scheduleTriggersTable.id,
    organizationId: schema.scheduleTriggersTable.organizationId,
    name: schema.scheduleTriggersTable.name,
    agentId: schema.scheduleTriggersTable.agentId,
    messageTemplate: schema.scheduleTriggersTable.messageTemplate,
    cronExpression: schema.scheduleTriggersTable.cronExpression,
    timezone: schema.scheduleTriggersTable.timezone,
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
