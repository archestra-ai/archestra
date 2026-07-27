import { eq, inArray } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import logger from "@/logging";

interface ModelTeamDetail {
  id: string;
  name: string;
}

/**
 * Team restrictions on LLM models. A model with no rows in `model_team` is
 * available to everyone; once rows exist, only members of the listed teams
 * (and model-catalog admins) may see or invoke the model.
 */
class ModelTeamModel {
  /**
   * Restriction team IDs per model. Models without restrictions are absent
   * from the returned map.
   */
  static async getTeamIdsForModels(
    modelIds: string[],
  ): Promise<Map<string, string[]>> {
    if (modelIds.length === 0) return new Map();

    const rows = await db
      .select({
        modelId: schema.modelTeamsTable.modelId,
        teamId: schema.modelTeamsTable.teamId,
      })
      .from(schema.modelTeamsTable)
      .where(inArray(schema.modelTeamsTable.modelId, modelIds));

    const map = new Map<string, string[]>();
    for (const { modelId, teamId } of rows) {
      const teamIds = map.get(modelId);
      if (teamIds) {
        teamIds.push(teamId);
      } else {
        map.set(modelId, [teamId]);
      }
    }
    return map;
  }

  /**
   * Team details (id + name) per model, for admin catalog display. Every
   * requested model gets an entry; unrestricted models map to an empty array.
   */
  static async getTeamDetailsForModels(
    modelIds: string[],
  ): Promise<Map<string, ModelTeamDetail[]>> {
    const teamsMap = new Map<string, ModelTeamDetail[]>();
    for (const modelId of modelIds) {
      teamsMap.set(modelId, []);
    }
    if (modelIds.length === 0) return teamsMap;

    const rows = await db
      .select({
        modelId: schema.modelTeamsTable.modelId,
        teamId: schema.modelTeamsTable.teamId,
        teamName: schema.teamsTable.name,
      })
      .from(schema.modelTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.modelTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.modelTeamsTable.modelId, modelIds));

    for (const { modelId, teamId, teamName } of rows) {
      teamsMap.get(modelId)?.push({ id: teamId, name: teamName });
    }
    return teamsMap;
  }

  /**
   * Replace a model's team restrictions. An empty array clears the
   * restriction, making the model available to everyone again.
   */
  static async syncModelTeams(
    modelId: string,
    teamIds: string[],
  ): Promise<void> {
    logger.debug(
      { modelId, teamCount: teamIds.length },
      "ModelTeamModel.syncModelTeams: syncing team restrictions",
    );
    await withDbTransaction(async (tx) => {
      await tx
        .delete(schema.modelTeamsTable)
        .where(eq(schema.modelTeamsTable.modelId, modelId));

      if (teamIds.length > 0) {
        await tx
          .insert(schema.modelTeamsTable)
          .values(teamIds.map((teamId) => ({ modelId, teamId })));
      }
    });
  }

  /**
   * Filter model IDs down to those the given principal may use: models with
   * no restriction, or restricted to at least one of `principalTeamIds`.
   * Callers handle any admin bypass before calling this.
   */
  static async filterAllowedModelIds(params: {
    modelIds: string[];
    principalTeamIds: string[];
  }): Promise<Set<string>> {
    const { modelIds, principalTeamIds } = params;
    const restrictions = await ModelTeamModel.getTeamIdsForModels(modelIds);
    const principalTeams = new Set(principalTeamIds);

    const allowed = new Set<string>();
    for (const modelId of modelIds) {
      const restrictedTo = restrictions.get(modelId);
      if (
        !restrictedTo ||
        restrictedTo.some((teamId) => principalTeams.has(teamId))
      ) {
        allowed.add(modelId);
      }
    }
    return allowed;
  }
}

export default ModelTeamModel;
