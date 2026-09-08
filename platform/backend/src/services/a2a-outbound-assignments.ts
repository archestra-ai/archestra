import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { A2aConnectionModel, AgentVersionModel } from "@/models";
import AgentToolModel from "@/models/agent-tool";
import type { A2aDelegationTarget } from "@/types";
import { ApiError } from "@/types";

export async function listA2aDelegations(
  agentId: string,
  organizationId: string,
): Promise<A2aDelegationTarget[]> {
  const rows = await A2aConnectionModel.findAssignedTargets(
    agentId,
    organizationId,
  );
  return rows.map(({ remoteAgent, connection, tool }) => ({
    remoteAgentId: remoteAgent.id,
    connectionId: connection.id,
    toolId: tool.id,
    name: remoteAgent.name,
    description: remoteAgent.description,
    enabled: connection.enabled,
  }));
}

export async function syncA2aDelegations(params: {
  agentId: string;
  organizationId: string;
  connectionIds: string[];
}): Promise<{ added: string[]; removed: string[] }> {
  const requestedIds = [...new Set(params.connectionIds)];
  const [requestedTargets, currentTargets] = await Promise.all([
    A2aConnectionModel.findTargetsByIdsForOrganization({
      ids: requestedIds,
      organizationId: params.organizationId,
    }),
    A2aConnectionModel.findAssignedTargets(
      params.agentId,
      params.organizationId,
    ),
  ]);

  if (requestedTargets.length !== requestedIds.length) {
    throw new ApiError(
      400,
      "One or more outbound A2A connections are missing, disabled, or belong to another organization",
    );
  }

  const duplicateName = firstDuplicate(
    requestedTargets.map((t) => t.tool.name),
  );
  if (duplicateName) {
    throw new ApiError(
      409,
      `Outbound A2A agents collide on delegation tool name "${duplicateName}". Rename one before assigning both.`,
    );
  }

  const requestedToolIds = new Set(requestedTargets.map((t) => t.tool.id));
  if (requestedTargets.length > 0) {
    const collisions = await db
      .select({ id: schema.toolsTable.id, name: schema.toolsTable.name })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, params.agentId),
          inArray(
            schema.toolsTable.name,
            requestedTargets.map((t) => t.tool.name),
          ),
        ),
      );
    const conflictingName = collisions.find(
      (row) => !requestedToolIds.has(row.id),
    )?.name;
    if (conflictingName) {
      throw new ApiError(
        409,
        `Delegation tool name "${conflictingName}" is already assigned to this agent`,
      );
    }
  }

  const currentByConnectionId = new Map(
    currentTargets.map((target) => [target.connection.id, target]),
  );
  const requestedByConnectionId = new Map(
    requestedTargets.map((target) => [target.connection.id, target]),
  );
  const removed = [...currentByConnectionId.keys()].filter(
    (id) => !requestedByConnectionId.has(id),
  );
  const added = [...requestedByConnectionId.keys()].filter(
    (id) => !currentByConnectionId.has(id),
  );

  for (const connectionId of removed) {
    const target = currentByConnectionId.get(connectionId);
    if (target) {
      await AgentToolModel.delete({
        agentId: params.agentId,
        toolId: target.tool.id,
        deferVersionFork: true,
      });
    }
  }
  for (const connectionId of added) {
    const target = requestedByConnectionId.get(connectionId);
    if (target) {
      await AgentToolModel.createIfNotExists(params.agentId, target.tool.id);
    }
  }
  if (added.length > 0 || removed.length > 0) {
    await AgentVersionModel.forkIfChangedBestEffort(params.agentId);
  }
  return { added, removed };
}

function firstDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}
