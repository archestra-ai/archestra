import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentMemory, InsertAgentMemory, MemoryScopeType } from "@/types";

class AgentMemoryModel {
  static async findByScope(params: {
    organizationId: string;
    scopeType: MemoryScopeType;
    scopeId: string;
  }): Promise<AgentMemory[]> {
    return db
      .select()
      .from(schema.agentMemoriesTable)
      .where(
        and(
          eq(schema.agentMemoriesTable.organizationId, params.organizationId),
          eq(schema.agentMemoriesTable.scopeType, params.scopeType),
          eq(schema.agentMemoriesTable.scopeId, params.scopeId),
        ),
      )
      .orderBy(schema.agentMemoriesTable.key);
  }

  /**
   * Fetch memories for multiple scopes at once (e.g., user + their teams + org).
   * Returns a flat list deduped by scope.
   */
  static async findForContext(params: {
    organizationId: string;
    userId: string;
    teamIds: string[];
  }): Promise<AgentMemory[]> {
    const { organizationId, userId, teamIds } = params;

    // Fetch user, team, and org memories in parallel
    const [userMemories, teamMemoriesArrays, orgMemories] = await Promise.all([
      AgentMemoryModel.findByScope({
        organizationId,
        scopeType: "user",
        scopeId: userId,
      }),
      Promise.all(
        teamIds.map((teamId) =>
          AgentMemoryModel.findByScope({
            organizationId,
            scopeType: "team",
            scopeId: teamId,
          }),
        ),
      ),
      AgentMemoryModel.findByScope({
        organizationId,
        scopeType: "org",
        scopeId: organizationId,
      }),
    ]);

    const teamMemories = teamMemoriesArrays.flat();
    return [...userMemories, ...teamMemories, ...orgMemories];
  }

  static async upsert(params: InsertAgentMemory): Promise<AgentMemory> {
    const [result] = await db
      .insert(schema.agentMemoriesTable)
      .values({
        organizationId: params.organizationId,
        scopeType: params.scopeType,
        scopeId: params.scopeId,
        key: params.key,
        value: params.value,
      })
      .onConflictDoUpdate({
        target: [
          schema.agentMemoriesTable.organizationId,
          schema.agentMemoriesTable.scopeType,
          schema.agentMemoriesTable.scopeId,
          schema.agentMemoriesTable.key,
        ],
        set: {
          value: params.value,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!result) {
      throw new Error("Failed to upsert agent memory");
    }

    return result;
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const result = await db
      .delete(schema.agentMemoriesTable)
      .where(
        and(
          eq(schema.agentMemoriesTable.id, params.id),
          eq(schema.agentMemoriesTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.agentMemoriesTable.id });

    return result.length > 0;
  }

  /**
   * Build a formatted memory block suitable for injection into a system prompt.
   */
  static formatMemoriesForPrompt(memories: AgentMemory[]): string {
    if (memories.length === 0) return "";

    const byScope: Record<string, AgentMemory[]> = {};
    for (const m of memories) {
      const label =
        m.scopeType === "user"
          ? "User"
          : m.scopeType === "team"
            ? "Team"
            : "Organization";
      byScope[label] = byScope[label] ?? [];
      byScope[label].push(m);
    }

    const sections = Object.entries(byScope).map(([label, mems]) => {
      const lines = mems.map((m) => `  - ${m.key}: ${m.value}`).join("\n");
      return `${label} context:\n${lines}`;
    });

    return `<agent_memory>\n${sections.join("\n\n")}\n</agent_memory>`;
  }
}

export default AgentMemoryModel;
