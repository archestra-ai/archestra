import { and, asc, eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { AssignedSkill } from "@/types";
import { assignedSkillColumns } from "./agent-skill";

/**
 * Data access for per-agent single-skill exclusions (Auto skill mode).
 * Pure CRUD — exposure rules live in services/agent-skill-resolution.ts.
 *
 * Reads still join `skills` and filter `notDeleted` as a defensive boundary,
 * while skill deletion transactionally removes these bindings so restore never
 * re-applies an exclusion that no longer exists in the agent configuration.
 */
class AgentExcludedSkillModel {
  static async findSkillIdsByAgent(
    agentId: string,
    tx?: Transaction,
  ): Promise<string[]> {
    const rows = await (tx ?? db)
      .select({ skillId: schema.agentExcludedSkillsTable.skillId })
      .from(schema.agentExcludedSkillsTable)
      // Keep the live-skill join as a defensive boundary even though repository
      // deletion removes exclusions in the same transaction.
      .innerJoin(
        schema.skillsTable,
        eq(schema.agentExcludedSkillsTable.skillId, schema.skillsTable.id),
      )
      .where(
        and(
          eq(schema.agentExcludedSkillsTable.agentId, agentId),
          notDeleted(schema.skillsTable),
        ),
      )
      .orderBy(asc(schema.agentExcludedSkillsTable.skillId));

    return rows.map((row) => row.skillId);
  }

  /**
   * Whether one skill is excluded from this agent's Auto-mode surface.
   *
   * The by-key twin of {@link findSkillIdsByAgent}: resolving a single
   * `skill://` URI needs one indexed lookup, not the agent's whole exclusion
   * list. No soft-delete join here — the caller already holds a live skill row.
   */
  static async isExcluded(params: {
    agentId: string;
    skillId: string;
  }): Promise<boolean> {
    const [row] = await db
      .select({ skillId: schema.agentExcludedSkillsTable.skillId })
      .from(schema.agentExcludedSkillsTable)
      .where(
        and(
          eq(schema.agentExcludedSkillsTable.agentId, params.agentId),
          eq(schema.agentExcludedSkillsTable.skillId, params.skillId),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  /**
   * The agent's excluded skills as picker-sized rows, ordered by skill id —
   * the exclusion twin of `AgentSkillModel.findSkillSummariesByAgent`, and
   * both environment-unfiltered and id-ordered for the same reasons.
   */
  static async findSkillSummariesByAgent(
    agentId: string,
  ): Promise<AssignedSkill[]> {
    return await db
      .select(assignedSkillColumns)
      .from(schema.agentExcludedSkillsTable)
      .innerJoin(
        schema.skillsTable,
        eq(schema.agentExcludedSkillsTable.skillId, schema.skillsTable.id),
      )
      .where(
        and(
          eq(schema.agentExcludedSkillsTable.agentId, agentId),
          notDeleted(schema.skillsTable),
        ),
      )
      .orderBy(asc(schema.agentExcludedSkillsTable.skillId));
  }

  /**
   * Full replace of the agent's excluded skill set.
   *
   * Callers that need the replace serialized against concurrent ones take
   * `AgentModel.lockRowForUpdate` first.
   */
  static async replaceExclusions(
    params: { agentId: string; skillIds: string[] },
    tx?: Transaction,
  ): Promise<void> {
    const run = async (tx: Transaction) => {
      await tx
        .delete(schema.agentExcludedSkillsTable)
        .where(eq(schema.agentExcludedSkillsTable.agentId, params.agentId));

      if (params.skillIds.length > 0) {
        await tx
          .insert(schema.agentExcludedSkillsTable)
          .values(
            [...new Set(params.skillIds)].map((skillId) => ({
              agentId: params.agentId,
              skillId,
            })),
          )
          // A row a concurrent replace already re-inserted is the same row this
          // one wants; the unique index must not turn that race into a 500.
          .onConflictDoNothing();
      }
    };

    if (tx) return await run(tx);
    await db.transaction(run);
  }
}

export default AgentExcludedSkillModel;
