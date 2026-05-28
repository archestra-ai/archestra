import { desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { AgentVersion, PromptSnapshotV1 } from "@/types";

class AgentVersionModel {
  /**
   * Record a new version of an agent's system prompt.
   *
   * Deduplicates: if the incoming systemPrompt is identical to the latest
   * snapshot, no row is written and null is returned. Uses SELECT FOR UPDATE
   * on the agent row to serialize concurrent writes.
   */
  static async record(params: {
    agentId: string;
    organizationId: string;
    systemPrompt: string | null;
    source: "create" | "update" | "restore";
    userId: string | null;
    userName: string | null;
  }): Promise<{ id: string; versionNumber: number } | null> {
    const { agentId, organizationId, systemPrompt, source, userId, userName } =
      params;

    logger.debug({ agentId, source }, "AgentVersionModel.record: starting");

    const result = await db.transaction(async (tx) => {
      // Lock the agent row to serialize concurrent version writes
      const [lockedAgent] = await tx
        .select({ id: schema.agentsTable.id })
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.id, agentId))
        .for("update");

      if (!lockedAgent) {
        logger.debug(
          { agentId },
          "AgentVersionModel.record: agent not found, skipping",
        );
        return null;
      }

      // Fetch latest version to dedup and derive next version number
      const [latest] = await tx
        .select()
        .from(schema.agentVersionsTable)
        .where(eq(schema.agentVersionsTable.agentId, agentId))
        .orderBy(desc(schema.agentVersionsTable.versionNumber))
        .limit(1);

      // Dedup: skip when systemPrompt is identical to the latest snapshot
      if (latest) {
        const latestSnapshot = latest.snapshot as PromptSnapshotV1;
        if (latestSnapshot.systemPrompt === systemPrompt) {
          logger.debug(
            { agentId, versionNumber: latest.versionNumber },
            "AgentVersionModel.record: prompt unchanged, skipping",
          );
          return null;
        }
      }

      const nextVersionNumber = (latest?.versionNumber ?? 0) + 1;
      const snapshot: PromptSnapshotV1 = { version: "1", systemPrompt };

      const [inserted] = await tx
        .insert(schema.agentVersionsTable)
        .values({
          agentId,
          organizationId,
          versionNumber: nextVersionNumber,
          snapshot,
          source,
          createdBy: userId,
          createdByName: userName,
        })
        .returning({
          id: schema.agentVersionsTable.id,
          versionNumber: schema.agentVersionsTable.versionNumber,
        });

      logger.debug(
        { agentId, versionNumber: nextVersionNumber, source },
        "AgentVersionModel.record: completed",
      );

      return inserted ?? null;
    });

    return result;
  }

  static async getLatest(agentId: string): Promise<AgentVersion | null> {
    logger.debug({ agentId }, "AgentVersionModel.getLatest: fetching");

    const [version] = await db
      .select()
      .from(schema.agentVersionsTable)
      .where(eq(schema.agentVersionsTable.agentId, agentId))
      .orderBy(desc(schema.agentVersionsTable.versionNumber))
      .limit(1);

    logger.debug(
      { agentId, found: !!version },
      "AgentVersionModel.getLatest: completed",
    );

    return (version as AgentVersion) ?? null;
  }
}

export default AgentVersionModel;
