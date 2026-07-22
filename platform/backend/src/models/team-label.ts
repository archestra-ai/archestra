import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { AgentLabelGetResponse, AgentLabelWithDetails } from "@/types";
import AgentLabelModel from "./agent-label";

class TeamLabelModel {
  /**
   * Get all labels for a specific team with key and value details
   */
  static async getLabelsForTeam(
    teamId: string,
  ): Promise<AgentLabelGetResponse[]> {
    const rows = await db
      .select({
        keyId: schema.teamLabelsTable.keyId,
        valueId: schema.teamLabelsTable.valueId,
        key: schema.labelKeysTable.key,
        value: schema.labelValuesTable.value,
      })
      .from(schema.teamLabelsTable)
      .leftJoin(
        schema.labelKeysTable,
        eq(schema.teamLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .leftJoin(
        schema.labelValuesTable,
        eq(schema.teamLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(eq(schema.teamLabelsTable.teamId, teamId))
      .orderBy(asc(schema.labelKeysTable.key));

    return rows.map((row) => ({
      keyId: row.keyId,
      valueId: row.valueId,
      key: row.key || "",
      value: row.value || "",
    }));
  }

  /**
   * Get labels for multiple teams in one query to avoid N+1
   */
  static async getLabelsForTeams(
    teamIds: string[],
  ): Promise<Map<string, AgentLabelWithDetails[]>> {
    const labelsMap = new Map<string, AgentLabelWithDetails[]>();
    for (const teamId of teamIds) {
      labelsMap.set(teamId, []);
    }

    if (teamIds.length === 0) {
      return labelsMap;
    }

    const rows = await db
      .select({
        teamId: schema.teamLabelsTable.teamId,
        keyId: schema.teamLabelsTable.keyId,
        valueId: schema.teamLabelsTable.valueId,
        key: schema.labelKeysTable.key,
        value: schema.labelValuesTable.value,
      })
      .from(schema.teamLabelsTable)
      .leftJoin(
        schema.labelKeysTable,
        eq(schema.teamLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .leftJoin(
        schema.labelValuesTable,
        eq(schema.teamLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(inArray(schema.teamLabelsTable.teamId, teamIds))
      .orderBy(asc(schema.labelKeysTable.key));

    for (const row of rows) {
      const labels = labelsMap.get(row.teamId) || [];
      labels.push({
        keyId: row.keyId,
        valueId: row.valueId,
        key: row.key || "",
        value: row.value || "",
      });
      labelsMap.set(row.teamId, labels);
    }

    return labelsMap;
  }

  /**
   * Resolve the team IDs matching a parsed labels filter.
   * AND across keys (a team must match every key), OR within a key's values.
   * Returns an empty array when the filter matches no teams.
   */
  static async getTeamIdsMatchingLabels(
    labels: Record<string, string[]>,
  ): Promise<string[]> {
    let matchingIds: string[] | null = null;

    for (const [key, values] of Object.entries(labels)) {
      const rows = await db
        .selectDistinct({ teamId: schema.teamLabelsTable.teamId })
        .from(schema.teamLabelsTable)
        .innerJoin(
          schema.labelKeysTable,
          eq(schema.teamLabelsTable.keyId, schema.labelKeysTable.id),
        )
        .innerJoin(
          schema.labelValuesTable,
          eq(schema.teamLabelsTable.valueId, schema.labelValuesTable.id),
        )
        .where(
          and(
            eq(schema.labelKeysTable.key, key),
            inArray(schema.labelValuesTable.value, values),
          ),
        );

      const ids = rows.map((r) => r.teamId);
      matchingIds =
        matchingIds === null
          ? ids
          : matchingIds.filter((id) => ids.includes(id));

      if (matchingIds.length === 0) {
        return [];
      }
    }

    return matchingIds ?? [];
  }

  /**
   * Sync labels for a team (replaces all existing labels).
   * Reuses AgentLabelModel.getOrCreateKey/Value for the shared
   * label_keys/label_values tables. When an outer transaction is provided
   * (e.g. atomic team create/update), the writes join that transaction;
   * otherwise a dedicated transaction is opened. Pruning is fired only after
   * a self-managed transaction commits.
   */
  static async syncTeamLabels(
    teamId: string,
    labels: AgentLabelWithDetails[],
    tx?: Transaction,
  ): Promise<void> {
    if (tx) {
      await TeamLabelModel.replaceLabels(teamId, labels, tx);
      return;
    }

    await withDbTransaction((trx) =>
      TeamLabelModel.replaceLabels(teamId, labels, trx),
    );

    // Fire-and-forget pruning to avoid race conditions with concurrent operations
    AgentLabelModel.pruneKeysAndValues().catch(() => {});
  }

  /**
   * Get all label keys used by teams within an organization
   */
  static async getAllKeys(organizationId: string): Promise<string[]> {
    const rows = await db
      .select({ key: schema.labelKeysTable.key })
      .from(schema.teamLabelsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.teamLabelsTable.teamId, schema.teamsTable.id),
      )
      .innerJoin(
        schema.labelKeysTable,
        eq(schema.teamLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .where(eq(schema.teamsTable.organizationId, organizationId))
      .groupBy(schema.labelKeysTable.key)
      .orderBy(asc(schema.labelKeysTable.key));

    return rows.map((r) => r.key);
  }

  /**
   * Get all label values for a specific key, scoped to an organization's teams
   */
  static async getValuesByKey(params: {
    organizationId: string;
    key: string;
  }): Promise<string[]> {
    const { organizationId, key } = params;

    const values = await db
      .select({ value: schema.labelValuesTable.value })
      .from(schema.teamLabelsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.teamLabelsTable.teamId, schema.teamsTable.id),
      )
      .innerJoin(
        schema.labelKeysTable,
        eq(schema.teamLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .innerJoin(
        schema.labelValuesTable,
        eq(schema.teamLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(
        and(
          eq(schema.teamsTable.organizationId, organizationId),
          eq(schema.labelKeysTable.key, key),
        ),
      )
      .groupBy(schema.labelValuesTable.value)
      .orderBy(asc(schema.labelValuesTable.value));

    return values.map((v) => v.value);
  }

  /**
   * Get all label values (unscoped to key), used by an organization's teams
   */
  static async getAllValues(organizationId: string): Promise<string[]> {
    const rows = await db
      .select({ value: schema.labelValuesTable.value })
      .from(schema.teamLabelsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.teamLabelsTable.teamId, schema.teamsTable.id),
      )
      .innerJoin(
        schema.labelValuesTable,
        eq(schema.teamLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(eq(schema.teamsTable.organizationId, organizationId))
      .groupBy(schema.labelValuesTable.value)
      .orderBy(asc(schema.labelValuesTable.value));

    return rows.map((r) => r.value);
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  private static async replaceLabels(
    teamId: string,
    labels: AgentLabelWithDetails[],
    tx: Transaction,
  ): Promise<void> {
    // Delete all existing labels for this team
    await tx
      .delete(schema.teamLabelsTable)
      .where(eq(schema.teamLabelsTable.teamId, teamId));

    if (labels.length === 0) {
      return;
    }

    const inserts: { teamId: string; keyId: string; valueId: string }[] = [];
    for (const label of labels) {
      const keyId = await AgentLabelModel.getOrCreateKey(label.key, tx);
      const valueId = await AgentLabelModel.getOrCreateValue(label.value, tx);
      inserts.push({ teamId, keyId, valueId });
    }

    await tx.insert(schema.teamLabelsTable).values(inserts);
  }
}

export default TeamLabelModel;
