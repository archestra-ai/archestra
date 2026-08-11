import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { AssignedSkill } from "@/types";
import { assignedSkillColumns, liveSkillIdsQuery } from "./agent-skill";

/**
 * Data access for per-agent single-skill exclusions (Auto skill mode).
 * Pure CRUD — exposure rules live in services/agent-skill-resolution.ts.
 *
 * Skill deletion is a soft delete that keeps exclusion rows, so every read here
 * joins `skills` and filters `notDeleted`, and the replace deletes only live
 * rows (see {@link liveSkillIdsQuery}).
 */
class AgentExcludedSkillModel {
  static async findSkillIdsByAgent(
    agentId: string,
    tx?: Transaction,
  ): Promise<string[]> {
    const rows = await (tx ?? db)
      .select({ skillId: schema.agentExcludedSkillsTable.skillId })
      .from(schema.agentExcludedSkillsTable)
      // Skill deletion is a soft delete that keeps exclusion rows; filtering
      // here keeps deleted ids out of the GET response, which the PUT
      // round-trip would otherwise 404 on (`findByIds` skips deleted rows).
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
   * Deletes only rows whose skill is live: a soft-deleted skill's exclusion is
   * hidden from the caller, so a replace must leave it exactly as it found it
   * (see {@link liveSkillIdsQuery}) — otherwise toggling any unrelated
   * exclusion would silently re-publish that skill once it is restored from
   * trash. Callers that need the replace serialized against concurrent ones
   * take `AgentModel.lockRowForUpdate` first.
   */
  static async replaceExclusions(
    params: { agentId: string; skillIds: string[] },
    tx?: Transaction,
  ): Promise<void> {
    const run = async (tx: Transaction) => {
      await tx
        .delete(schema.agentExcludedSkillsTable)
        .where(
          and(
            eq(schema.agentExcludedSkillsTable.agentId, params.agentId),
            inArray(
              schema.agentExcludedSkillsTable.skillId,
              liveSkillIdsQuery(),
            ),
          ),
        );

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
