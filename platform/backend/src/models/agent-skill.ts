import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { skillInEnvironmentPredicate } from "@/services/environments/environment-isolation";
import type { AssignedSkill, PublishableSkill } from "@/types";
import {
  afterIdPredicate,
  publishableSkillColumns,
  publishableSkillPredicate,
  skillUriKeyPredicate,
} from "./skill";

/**
 * The skill columns an assignment endpoint returns: enough to render a picker
 * entry and decide publishability, and nothing else. Deliberately not the
 * catalog's list shape, which carries file counts, teams, environments and
 * usage stats behind six joins none of this needs.
 */
export const assignedSkillColumns = {
  id: schema.skillsTable.id,
  name: schema.skillsTable.name,
  description: schema.skillsTable.description,
  scope: schema.skillsTable.scope,
  templated: schema.skillsTable.templated,
  agentName: schema.skillsTable.agentName,
  authorId: schema.skillsTable.authorId,
} as const;

/**
 * Live (non-soft-deleted) skill ids, as a subquery for scoping the junction
 * tables' full-replace deletes.
 *
 * The write-side twin of the `notDeleted` join every read in these junction
 * models applies. A soft-deleted skill's junction row is invisible to every
 * read, so a full replace assembled from what the caller could see must not
 * destroy it. Unscoped, any unrelated replace wipes that row, and restoring the
 * skill from trash then silently changes what the gateway publishes — with an
 * audit diff that shows nothing, because the row was never in either snapshot.
 * Scoping the delete is what makes both models' "deletion keeps junction rows"
 * claim true on the write path too.
 */
export function liveSkillIdsQuery() {
  return db
    .select({ id: schema.skillsTable.id })
    .from(schema.skillsTable)
    .where(notDeleted(schema.skillsTable));
}

/**
 * Data access for explicit per-agent skill assignments (Custom skill mode).
 * Pure CRUD — exposure rules live in services/agent-skill-resolution.ts and
 * assignment validation in the route layer.
 *
 * Skill deletion is a soft delete that keeps junction rows, so every read here
 * joins `skills` and filters `notDeleted` — a dangling assignment must never
 * resurface a deleted skill (or its id) on any surface — and every replace
 * deletes only live rows (see {@link liveSkillIdsQuery}).
 */
class AgentSkillModel {
  static async findSkillIdsByAgent(
    agentId: string,
    tx?: Transaction,
  ): Promise<string[]> {
    const rows = await (tx ?? db)
      .select({ skillId: schema.agentSkillsTable.skillId })
      .from(schema.agentSkillsTable)
      .innerJoin(
        schema.skillsTable,
        eq(schema.agentSkillsTable.skillId, schema.skillsTable.id),
      )
      .where(
        and(
          eq(schema.agentSkillsTable.agentId, agentId),
          notDeleted(schema.skillsTable),
        ),
      )
      .orderBy(asc(schema.agentSkillsTable.skillId));

    return rows.map((row) => row.skillId);
  }

  /**
   * The agent's assigned skills as picker-sized rows, ordered by skill id.
   *
   * Id order rather than name order so the `skillIds` derived from these rows
   * keeps the order `findSkillIdsByAgent` established — the response is also
   * the PUT body, and callers diff it. Display order is the UI's business.
   *
   * Deliberately NOT environment-filtered, unlike {@link findSkillsByAgent}:
   * this backs the assignment API, where the set is the stored configuration
   * rather than what the gateway currently serves. Filtering here would drop an
   * out-of-environment assignment from the GET, and the next full-replace PUT
   * would then delete it — silently discarding configuration the admin never
   * touched. The PUT honors the same contract from its side: it validates only
   * ids being added, so the set echoed here always saves back unchanged.
   */
  static async findSkillSummariesByAgent(
    agentId: string,
  ): Promise<AssignedSkill[]> {
    return await db
      .select(assignedSkillColumns)
      .from(schema.agentSkillsTable)
      .innerJoin(
        schema.skillsTable,
        eq(schema.agentSkillsTable.skillId, schema.skillsTable.id),
      )
      .where(
        and(
          eq(schema.agentSkillsTable.agentId, agentId),
          notDeleted(schema.skillsTable),
        ),
      )
      .orderBy(asc(schema.agentSkillsTable.skillId));
  }

  /**
   * One keyset page of the agent's assigned skills, in skill-id order,
   * restricted to the agent's environment and to what can actually be
   * published.
   *
   * Joins rather than round-tripping through `findSkillIdsByAgent`, so
   * resolving an agent's Custom-mode surface stays one query. The environment
   * predicate is applied here, at serve time, so an assignment whose skill is
   * later rebound to another environment stops being published — mirroring how
   * assigned tools are re-checked against the agent's environment on every
   * resolution.
   *
   * Id order rather than name order because the id is the paging key; display
   * order was never this method's business, and the resolution used to re-sort
   * on top of it anyway. Carries the same page window and publication gates as
   * {@link SkillModel.findOrgScopedInEnvironment}, so both modes page
   * identically and a Custom gateway cannot list a skill an Auto one withholds.
   */
  static async findSkillsByAgent(params: {
    agentId: string;
    environmentId: string | null;
    /** Resume after this skill id; omit to start at the first page. */
    afterId?: string;
    limit: number;
  }): Promise<PublishableSkill[]> {
    const rows = await db
      .select({ skill: publishableSkillColumns() })
      .from(schema.agentSkillsTable)
      .innerJoin(
        schema.skillsTable,
        eq(schema.agentSkillsTable.skillId, schema.skillsTable.id),
      )
      .where(
        and(
          eq(schema.agentSkillsTable.agentId, params.agentId),
          notDeleted(schema.skillsTable),
          skillInEnvironmentPredicate(params.environmentId),
          publishableSkillPredicate(),
          afterIdPredicate(params.afterId),
        ),
      )
      .orderBy(asc(schema.skillsTable.id))
      .limit(params.limit);

    return rows.map((row) => row.skill);
  }

  /**
   * The single assigned skill a `skill://` URI names, or null.
   *
   * The by-key twin of {@link findSkillsByAgent}, for the same reason
   * `SkillModel.findOrgScopedByUriKey` exists: reading one skill's file should
   * cost one row, not the agent's whole assigned set. Carries the identical
   * join and gate predicates, so Custom mode cannot serve through a URI
   * anything its listing withholds.
   */
  static async findSkillByAgentAndUriKey(params: {
    agentId: string;
    environmentId: string | null;
    name: string;
    authorId: string | null;
  }): Promise<PublishableSkill | null> {
    const [row] = await db
      .select({ skill: publishableSkillColumns() })
      .from(schema.agentSkillsTable)
      .innerJoin(
        schema.skillsTable,
        eq(schema.agentSkillsTable.skillId, schema.skillsTable.id),
      )
      .where(
        and(
          eq(schema.agentSkillsTable.agentId, params.agentId),
          skillUriKeyPredicate(params),
          notDeleted(schema.skillsTable),
          skillInEnvironmentPredicate(params.environmentId),
          publishableSkillPredicate(),
        ),
      )
      .limit(1);

    return row?.skill ?? null;
  }

  /**
   * Full replace of the agent's assigned skill set, in one transaction so a
   * partial write can never leave the gateway exposing a half-applied
   * selection.
   *
   * Deletes only rows whose skill is live: a soft-deleted skill's assignment is
   * hidden from the caller, so a replace must leave it exactly as it found it
   * (see {@link liveSkillIdsQuery}). Callers that need the replace serialized
   * against concurrent ones take `AgentModel.lockRowForUpdate` first — the lock
   * belongs to the transaction, not to this statement.
   */
  static async replaceAssignments(
    params: { agentId: string; skillIds: string[] },
    tx?: Transaction,
  ): Promise<void> {
    const run = async (tx: Transaction) => {
      await tx
        .delete(schema.agentSkillsTable)
        .where(
          and(
            eq(schema.agentSkillsTable.agentId, params.agentId),
            inArray(schema.agentSkillsTable.skillId, liveSkillIdsQuery()),
          ),
        );

      if (params.skillIds.length > 0) {
        await tx
          .insert(schema.agentSkillsTable)
          .values(
            // dedupe: the unique index would reject a repeated id mid-insert.
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

export default AgentSkillModel;
