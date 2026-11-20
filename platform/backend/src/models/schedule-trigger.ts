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
import { z } from "zod";
import config from "@/config";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { decodeCursor } from "@/database/utils/pagination";
import type {
  InsertScheduleTrigger,
  ScheduleTrigger,
  UpdateScheduleTrigger,
} from "@/types";
import { ApiError, InsertScheduleTriggerSchema } from "@/types";
import { callRustApi } from "@/utils/rust-api";
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
  cursor?: string;
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
  ): Promise<(ScheduleTrigger & { cursorCreatedAt: string })[]> {
    const filters = buildListFilters(params);
    if (!filters) return [];

    const position = decodeCursor(params.cursor);
    if (
      position &&
      z.uuid().safeParse(position.id).success &&
      !Number.isNaN(Date.parse(position.value))
    ) {
      filters.push(
        sql`(${schema.scheduleTriggersTable.createdAt}, ${schema.scheduleTriggersTable.id}) < (${position.value}::timestamptz, ${position.id}::uuid)`,
      );
    }

    let query = db
      .select({
        ...triggerColumns(),
        // Preserve PostgreSQL microseconds when encoding the next page.
        cursorCreatedAt: sql<string>`${schema.scheduleTriggersTable.createdAt}::text`,
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
      .orderBy(
        desc(schema.scheduleTriggersTable.createdAt),
        desc(schema.scheduleTriggersTable.id),
      )
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

  static async findAccessTarget(id: string) {
    const trigger = schema.scheduleTriggersTable;
    const [row] = await db
      .select({
        id: trigger.id,
        organizationId: trigger.organizationId,
        projectId: trigger.projectId,
        actorUserId: trigger.actorUserId,
      })
      .from(trigger)
      .innerJoin(
        schema.agentsTable,
        and(
          eq(trigger.agentId, schema.agentsTable.id),
          notDeleted(schema.agentsTable),
        ),
      )
      .where(eq(trigger.id, id));
    return row ?? null;
  }

  static async create(data: InsertScheduleTrigger): Promise<ScheduleTrigger> {
    const [created] = await db
      .insert(schema.scheduleTriggersTable)
      .values(normalizeScheduleTriggerInsert(data))
      .returning();

    return (await ScheduleTriggerModel.findById(created.id)) ?? created;
  }

  static async createMcpNative(
    data: Omit<InsertScheduleTrigger, "lastExecutedAt"> & { projectId: string },
    signal: AbortSignal,
  ): Promise<ScheduleTrigger> {
    const { lastExecutedAt: _, ...columns } =
      normalizeScheduleTriggerInsert(data);
    const input = {
      ...columns,
      projectId: data.projectId,
      enabled: columns.enabled ?? true,
    };
    const socketPath = config.database.rustAuditLogSocket;
    if (!socketPath) throw new Error("Rust MCP tool socket is not configured");
    signal.throwIfAborted();
    const created = z
      .object({
        id: z.uuid(),
        createdAt: z.iso.datetime().transform((value) => new Date(value)),
      })
      .nullable()
      .parse(
        await callRustApi({
          socketPath,
          path: "/internal/v1/mcp/tools/create-schedule-trigger",
          json: JSON.stringify(input),
        }),
      );
    if (!created)
      throw new ApiError(404, "Schedule project or agent not found");
    return (
      (await ScheduleTriggerModel.findById(created.id)) ?? {
        ...input,
        ...created,
        lastExecutedAt: null,
      }
    );
  }

  static async update(
    id: string,
    data: Partial<UpdateScheduleTrigger>,
  ): Promise<ScheduleTrigger | null> {
    const [updated] = await db
      .update(schema.scheduleTriggersTable)
      .set(normalizeScheduleTriggerPatch(data))
      .where(eq(schema.scheduleTriggersTable.id, id))
      .returning({ id: schema.scheduleTriggersTable.id });

    if (!updated) {
      return null;
    }

    return await ScheduleTriggerModel.findById(updated.id);
  }

  static async updateMcpNative(params: {
    existing: ScheduleTrigger;
    data: Pick<
      Partial<UpdateScheduleTrigger>,
      | "name"
      | "agentId"
      | "projectId"
      | "enabled"
      | "cronExpression"
      | "timezone"
      | "messageTemplate"
    >;
    signal: AbortSignal;
  }): Promise<ScheduleTrigger | null> {
    const { existing, data, signal } = params;
    const {
      id,
      organizationId,
      projectId,
      agentId,
      actorUserId,
      cronExpression,
      timezone,
      messageTemplate,
    } = existing;
    const socketPath = config.database.rustAuditLogSocket;
    if (!socketPath) throw new Error("Rust MCP tool socket is not configured");
    signal.throwIfAborted();
    const updated = z
      .uuid()
      .nullable()
      .parse(
        await callRustApi({
          socketPath,
          path: "/internal/v1/mcp/tools/update-schedule-trigger",
          json: JSON.stringify({
            id,
            organizationId,
            expected: {
              projectId,
              agentId,
              actorUserId,
              cronExpression,
              timezone,
              messageTemplate,
            },
            patch: normalizeScheduleTriggerPatch(data),
          }),
        }),
      );
    return updated ? ScheduleTriggerModel.findById(updated) : null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.scheduleTriggersTable)
      .where(eq(schema.scheduleTriggersTable.id, id))
      .returning({ id: schema.scheduleTriggersTable.id });

    return result.length > 0;
  }

  static async deleteMcpNative(
    trigger: Pick<
      ScheduleTrigger,
      "id" | "organizationId" | "projectId" | "agentId" | "actorUserId"
    >,
    signal: AbortSignal,
  ): Promise<boolean> {
    const { id, organizationId, projectId, agentId, actorUserId } = trigger;
    const socketPath = config.database.rustAuditLogSocket;
    if (!socketPath) throw new Error("Rust MCP tool socket is not configured");
    signal.throwIfAborted();
    return z.boolean().parse(
      await callRustApi({
        socketPath,
        path: "/internal/v1/mcp/tools/delete-schedule-trigger",
        json: JSON.stringify({
          id,
          organizationId,
          projectId,
          agentId,
          actorUserId,
        }),
      }),
    );
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

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const trigger = await ScheduleTriggerModel.findById(id);
    if (!trigger || trigger.organizationId !== organizationId) return null;

    return {
      id: trigger.id,
      name: trigger.name,
      projectId: trigger.projectId,
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

function normalizeScheduleTriggerInsert(data: InsertScheduleTrigger) {
  const parsed = InsertScheduleTriggerSchema.parse(data);
  return {
    ...parsed,
    cronExpression: normalizeCronExpression(parsed.cronExpression),
    timezone: normalizeTimezone(parsed.timezone),
  };
}

function normalizeScheduleTriggerPatch(data: Partial<UpdateScheduleTrigger>) {
  return {
    ...data,
    ...(data.cronExpression !== undefined && {
      cronExpression: normalizeCronExpression(data.cronExpression),
    }),
    ...(data.timezone !== undefined && {
      timezone: normalizeTimezone(data.timezone),
    }),
  };
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
    // in `findAccessibleScheduleTriggerOrThrow`
    // (services/schedule-trigger-access.ts).
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
