import type {
  ResourcePermissionAction,
  ResourcePermissionGrant,
} from "@archestra/shared";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";

/**
 * Share a project, chat or run the way the Permissions tab does: by rewriting
 * the object's permission policy. The grants its owner holds are kept, and the
 * given audience replaces every other grant. `null` makes it owner-only.
 */
export async function shareForTest(params: {
  organizationId: string;
  resource: "project" | "conversation" | "agentRun";
  scope: string;
  visibility: "organization" | "team" | "user" | null;
  teamIds?: string[];
  userIds?: string[];
}): Promise<void> {
  const key = {
    organizationId: params.organizationId,
    resource: params.resource,
    scope: params.scope,
  };
  // A project recipient works in the project; a session recipient only reads.
  const actions: ResourcePermissionAction[] =
    params.resource === "project" ? ["read", "use"] : ["read"];
  const audience: ResourcePermissionGrant[] =
    params.visibility === "organization"
      ? [{ subject: { type: "organization", id: "*" }, actions }]
      : params.visibility === "team"
        ? (params.teamIds ?? []).map((id) => ({
            subject: { type: "team", id },
            actions,
          }))
        : params.visibility === "user"
          ? (params.userIds ?? []).map((id) => ({
              subject: { type: "user", id },
              actions,
            }))
          : [];
  const policy = await ResourcePermissionPolicyModel.find(key);
  const kept = (policy?.grants ?? []).filter((grant) =>
    grant.actions.includes("manage-permissions"),
  );
  const replaced = await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: [...kept, ...audience],
  });
  if (!replaced) throw new Error("failed to share for test");
}

/**
 * Write a row into one of the retired share tables, the way sharing was stored
 * before permission policies. Only the upgrade still reads these tables, so
 * only its tests need to seed them.
 */
export async function seedLegacyShareForTest(params: {
  organizationId: string;
  resource: "project" | "conversation" | "agentRun";
  scope: string;
  createdByUserId: string;
  visibility: "organization" | "team" | "user";
  teamIds?: string[];
  userIds?: string[];
}): Promise<void> {
  const teamIds = params.teamIds ?? [];
  const userIds = params.userIds ?? [];
  const row = {
    organizationId: params.organizationId,
    createdByUserId: params.createdByUserId,
    visibility: params.visibility,
  };
  if (params.resource === "project") {
    const [share] = await db
      .insert(schema.projectSharesTable)
      .values({ ...row, projectId: params.scope })
      .returning();
    if (teamIds.length > 0)
      await db
        .insert(schema.projectShareTeamsTable)
        .values(teamIds.map((teamId) => ({ shareId: share.id, teamId })));
    if (userIds.length > 0)
      await db
        .insert(schema.projectShareUsersTable)
        .values(userIds.map((userId) => ({ shareId: share.id, userId })));
    return;
  }
  if (params.resource === "conversation") {
    const [share] = await db
      .insert(schema.conversationSharesTable)
      .values({ ...row, conversationId: params.scope })
      .returning();
    if (teamIds.length > 0)
      await db
        .insert(schema.conversationShareTeamsTable)
        .values(teamIds.map((teamId) => ({ shareId: share.id, teamId })));
    if (userIds.length > 0)
      await db
        .insert(schema.conversationShareUsersTable)
        .values(userIds.map((userId) => ({ shareId: share.id, userId })));
    return;
  }
  const [share] = await db
    .insert(schema.agentRunSharesTable)
    .values({ ...row, taskId: params.scope })
    .returning();
  if (teamIds.length > 0)
    await db
      .insert(schema.agentRunShareTeamsTable)
      .values(teamIds.map((teamId) => ({ shareId: share.id, teamId })));
  if (userIds.length > 0)
    await db
      .insert(schema.agentRunShareUsersTable)
      .values(userIds.map((userId) => ({ shareId: share.id, userId })));
}
