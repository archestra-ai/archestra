import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  AgentWorkspace,
  InsertAgentWorkspace,
} from "@/types/agent-workspace";

class AgentWorkspaceModel {
  static async create(input: InsertAgentWorkspace): Promise<AgentWorkspace> {
    const [row] = await db
      .insert(schema.agentWorkspacesTable)
      .values(input)
      .returning();
    return row;
  }

  static async findByWorkloadName(
    name: string,
  ): Promise<AgentWorkspace | null> {
    const [row] = await db
      .select()
      .from(schema.agentWorkspacesTable)
      .where(eq(schema.agentWorkspacesTable.workloadName, name));
    return row ?? null;
  }

  static async claim(params: {
    id: string;
    organizationId: string;
    actorKind: AgentWorkspace["actorKind"];
    actorId: string;
    agentId: string;
    taskId: string;
  }): Promise<AgentWorkspace | null> {
    const table = schema.agentWorkspacesTable;
    const now = new Date();
    const [row] = await db
      .update(table)
      .set({
        state: "active",
        activeTaskId: params.taskId,
        lastTaskId: params.taskId,
        idleAt: null,
        lastActivityAt: now,
      })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
          eq(table.actorKind, params.actorKind),
          eq(table.actorId, params.actorId),
          eq(table.agentId, params.agentId),
          isNull(table.activeTaskId),
          inArray(table.state, ["idle", "suspended"]),
          gt(table.expiresAt, now),
        ),
      )
      .returning();
    return row ?? null;
  }

  static async release(params: {
    workloadName: string;
    taskId: string;
  }): Promise<void> {
    const table = schema.agentWorkspacesTable;
    await db
      .update(table)
      .set({
        state: "idle",
        activeTaskId: null,
        idleAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(
        and(
          eq(table.workloadName, params.workloadName),
          eq(table.activeTaskId, params.taskId),
          eq(table.state, "active"),
        ),
      );
  }

  static async listForReaping(idleBefore: Date): Promise<AgentWorkspace[]> {
    const table = schema.agentWorkspacesTable;
    return db
      .select()
      .from(table)
      .where(
        and(
          inArray(table.state, [
            "active",
            "idle",
            "suspending",
            "suspended",
            "resuming",
            "deleting",
          ]),
          or(
            lte(table.expiresAt, new Date()),
            and(eq(table.state, "idle"), lte(table.lastActivityAt, idleBefore)),
            inArray(table.state, ["deleting", "suspending", "resuming"]),
          ),
        ),
      );
  }

  static async transition(params: {
    id: string;
    from: AgentWorkspace["state"];
    to: AgentWorkspace["state"];
    expectedLastActivityAt?: Date;
  }): Promise<boolean> {
    const table = schema.agentWorkspacesTable;
    const rows = await db
      .update(table)
      .set({ state: params.to })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.state, params.from),
          params.expectedLastActivityAt
            ? eq(table.lastActivityAt, params.expectedLastActivityAt)
            : undefined,
        ),
      )
      .returning({ id: table.id });
    return rows.length === 1;
  }

  static async recordActivity(id: string): Promise<boolean> {
    const table = schema.agentWorkspacesTable;
    const rows = await db
      .update(table)
      .set({ lastActivityAt: new Date() })
      .where(
        and(
          eq(table.id, id),
          inArray(table.state, ["active", "idle"]),
          gt(table.expiresAt, new Date()),
        ),
      )
      .returning({ id: table.id });
    return rows.length === 1;
  }

  static async finishResume(id: string): Promise<boolean> {
    const table = schema.agentWorkspacesTable;
    const now = new Date();
    const rows = await db
      .update(table)
      .set({ state: "idle", lastActivityAt: now, idleAt: now })
      .where(
        and(
          eq(table.id, id),
          eq(table.state, "resuming"),
          gt(table.expiresAt, now),
        ),
      )
      .returning({ id: table.id });
    return rows.length === 1;
  }
}

export default AgentWorkspaceModel;
