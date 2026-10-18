// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { AUTO_PROVISIONED_INVITATION_STATUS } from "@archestra/shared/consts";
import { and, asc, eq, inArray, is, isNull, ne, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import db, { schema, type Transaction } from "@/database";

/** Data access for retiring an unclaimed Teams identity during SSO profile sync. */
class SsoPendingUserModel {
  static async reconcile(params: {
    userId: string;
    email: string;
    providerId: string;
    organizationId: string;
    requestPath: string;
  }): Promise<"unchanged" | "reconciled" | "conflict"> {
    return db.transaction(async (tx) => {
      // Stable ordering also serializes two callbacks trying to claim the same
      // placeholder. A user-row lock blocks new FK-backed accounts/sessions.
      const users = await tx
        .select()
        .from(schema.usersTable)
        .where(
          sql`${schema.usersTable.id} = ${params.userId} OR ${schema.usersTable.email} = ${params.email}`,
        )
        .orderBy(asc(schema.usersTable.id))
        .for("update");
      const user = users.find((row) => row.id === params.userId);
      const pending = users.find((row) => row.email === params.email);
      if (!user || !pending || pending.id === user.id) return "unchanged";

      const accounts = await tx
        .select({ userId: schema.accountsTable.userId })
        .from(schema.accountsTable)
        .where(inArray(schema.accountsTable.userId, [user.id, pending.id]));
      const [ssoAccount] = await tx
        .select({ id: schema.accountsTable.id })
        .from(schema.accountsTable)
        .where(
          and(
            eq(schema.accountsTable.userId, user.id),
            eq(schema.accountsTable.providerId, params.providerId),
          ),
        );
      const memberships = await tx
        .select()
        .from(schema.membersTable)
        .where(inArray(schema.membersTable.userId, [user.id, pending.id]));
      const pendingMemberships = memberships.filter(
        (row) => row.userId === pending.id,
      );
      const [invitation] = await tx
        .select({ id: schema.invitationsTable.id })
        .from(schema.invitationsTable)
        .where(
          and(
            eq(schema.invitationsTable.organizationId, params.organizationId),
            eq(schema.invitationsTable.email, pending.email),
            eq(schema.invitationsTable.inviterId, pending.id),
            eq(
              schema.invitationsTable.status,
              `${AUTO_PROVISIONED_INVITATION_STATUS}:ms-teams`,
            ),
          ),
        );
      if (
        !ssoAccount ||
        user.banned ||
        pending.emailVerified ||
        pending.twoFactorEnabled ||
        pending.banned ||
        accounts.some((row) => row.userId === pending.id) ||
        pendingMemberships.length !== 1 ||
        pendingMemberships[0].organizationId !== params.organizationId ||
        !memberships.some(
          (row) =>
            row.userId === user.id &&
            row.organizationId === params.organizationId,
        ) ||
        !invitation
      ) {
        return "conflict";
      }

      // Only move data produced by an unauthenticated chat participant. An
      // unexpected credential, session, or new kind of owned resource fails
      // closed instead of being silently cascaded away by the user deletion.
      if (await SsoPendingUserModel.hasUnsupportedReferences(tx, pending.id))
        return "conflict";

      const [otherInvitation] = await tx
        .select({ id: schema.invitationsTable.id })
        .from(schema.invitationsTable)
        .where(
          and(
            eq(schema.invitationsTable.inviterId, pending.id),
            ne(schema.invitationsTable.id, invitation.id),
          ),
        );
      const [foreignAgent] = await tx
        .select({ id: schema.agentsTable.id })
        .from(schema.agentsTable)
        .where(
          and(
            eq(schema.agentsTable.authorId, pending.id),
            ne(schema.agentsTable.organizationId, params.organizationId),
          ),
        );
      const [activeTask] = await tx
        .select({ id: schema.a2aTasksTable.id })
        .from(schema.a2aTasksTable)
        .innerJoin(
          schema.a2aContextsTable,
          eq(schema.a2aTasksTable.contextId, schema.a2aContextsTable.id),
        )
        .where(
          and(
            eq(schema.a2aContextsTable.actorKind, "user"),
            eq(schema.a2aContextsTable.actorId, pending.id),
            inArray(schema.a2aTasksTable.state, [
              "TASK_STATE_SUBMITTED",
              "TASK_STATE_WORKING",
            ]),
          ),
        )
        .limit(1);
      const [activeChat] = await tx
        .select({ id: schema.chatActiveRunsTable.id })
        .from(schema.chatActiveRunsTable)
        .where(
          and(
            eq(schema.chatActiveRunsTable.userId, pending.id),
            eq(schema.chatActiveRunsTable.status, "running"),
          ),
        )
        .limit(1);
      if (otherInvitation || foreignAgent || activeTask || activeChat)
        return "conflict";

      // Keep the signed-up user's personal gateway. Preserve a redundant
      // placeholder gateway as a deleted ordinary gateway so its history and
      // references survive without violating the one-personal-gateway index.
      for (const flag of ["isPersonalGateway", "isPersonalProxy"] as const) {
        const [existing] = await tx
          .select({ id: schema.agentsTable.id })
          .from(schema.agentsTable)
          .where(
            and(
              eq(schema.agentsTable.authorId, user.id),
              eq(schema.agentsTable.organizationId, params.organizationId),
              eq(schema.agentsTable[flag], true),
              isNull(schema.agentsTable.deletedAt),
            ),
          );
        if (existing)
          await tx
            .update(schema.agentsTable)
            .set({ [flag]: false, deletedAt: new Date() })
            .where(
              and(
                eq(schema.agentsTable.authorId, pending.id),
                eq(schema.agentsTable[flag], true),
                isNull(schema.agentsTable.deletedAt),
              ),
            );
      }

      // A pending user can already have been added to a team. Keep existing
      // canonical memberships unchanged when both identities are in that team.
      const teamMemberships = await tx
        .select()
        .from(schema.teamMembersTable)
        .where(eq(schema.teamMembersTable.userId, pending.id));
      for (const membership of teamMemberships) {
        await tx
          .insert(schema.teamMembersTable)
          .values({ ...membership, userId: user.id, id: crypto.randomUUID() })
          .onConflictDoNothing();
      }

      const policies = await tx
        .select({
          organizationId: schema.resourcePermissionPoliciesTable.organizationId,
          resource: schema.resourcePermissionPoliciesTable.resource,
          scope: schema.resourcePermissionPoliciesTable.scope,
          grants: schema.resourcePermissionPoliciesTable.grants,
          revision: schema.resourcePermissionPoliciesTable.revision,
        })
        .from(schema.resourcePermissionPoliciesTable)
        .where(
          and(
            eq(
              schema.resourcePermissionPoliciesTable.organizationId,
              params.organizationId,
            ),
            sql`${schema.resourcePermissionPoliciesTable.grants} @> ${JSON.stringify([{ subject: { type: "user", id: pending.id } }])}::jsonb`,
          ),
        )
        .for("update");
      for (const policy of policies) {
        await tx
          .update(schema.resourcePermissionPoliciesTable)
          .set({
            grants: policy.grants.map((grant) =>
              grant.subject.type === "user" && grant.subject.id === pending.id
                ? { ...grant, subject: { type: "user" as const, id: user.id } }
                : grant,
            ),
            revision: policy.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(
                schema.resourcePermissionPoliciesTable.organizationId,
                policy.organizationId,
              ),
              eq(
                schema.resourcePermissionPoliciesTable.resource,
                policy.resource,
              ),
              eq(schema.resourcePermissionPoliciesTable.scope, policy.scope),
            ),
          );
      }

      for (const column of TRANSFER_COLUMNS) {
        await tx.execute(
          sql`UPDATE ${column.table} SET ${sql.identifier(column.name)} = ${user.id} WHERE ${column} = ${pending.id}`,
        );
      }
      // Actor ownership is not FK-backed; it must move before the old user is
      // removed or the next Teams turn cannot resume its existing context.
      await tx
        .update(schema.a2aContextsTable)
        .set({ actorId: user.id })
        .where(
          and(
            eq(schema.a2aContextsTable.actorKind, "user"),
            eq(schema.a2aContextsTable.actorId, pending.id),
          ),
        );
      await tx
        .update(schema.agentRunsTable)
        .set({ actorId: user.id })
        .where(
          and(
            eq(schema.agentRunsTable.actorKind, "user"),
            eq(schema.agentRunsTable.actorId, pending.id),
          ),
        );

      await tx
        .update(schema.agentWorkspacesTable)
        .set({ actorId: user.id })
        .where(
          and(
            eq(schema.agentWorkspacesTable.actorKind, "user"),
            eq(schema.agentWorkspacesTable.actorId, pending.id),
          ),
        );

      await tx.insert(schema.auditLogsTable).values({
        organizationId: params.organizationId,
        actorId: user.id,
        actorType: "user",
        actorName: user.name,
        actorEmail: params.email,
        action: "member.deleted",
        outcome: "success",
        resourceType: "member",
        resourceId: pendingMemberships[0].id,
        resourceName: pending.name,
        before: {
          userId: pending.id,
          email: pending.email,
          status: "auto-provisioned",
        },
        after: { reconciledIntoUserId: user.id, email: params.email },
        httpPath: params.requestPath,
        occurredAt: new Date(),
      });
      // Accounts and sessions on the canonical user are untouched. The
      // placeholder's only remaining FK rows are its membership/invitation.
      await tx
        .delete(schema.usersTable)
        .where(eq(schema.usersTable.id, pending.id));
      await tx
        .update(schema.usersTable)
        .set({ email: params.email, updatedAt: new Date() })
        .where(eq(schema.usersTable.id, user.id));
      return "reconciled";
    });
  }

  private static async hasUnsupportedReferences(
    tx: Transaction,
    userId: string,
  ) {
    const handled = new Set([
      ...TRANSFER_COLUMNS,
      schema.membersTable.userId,
      schema.invitationsTable.inviterId,
      schema.teamMembersTable.userId,
    ]);
    const queries = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .flatMap((table) =>
        getTableConfig(table).foreignKeys.flatMap((key) => {
          const reference = key.reference();
          if (reference.foreignTable !== schema.usersTable) return [];
          return reference.columns
            .filter(
              (column) =>
                !handled.has(column as (typeof TRANSFER_COLUMNS)[number]),
            )
            .map(
              (column) =>
                sql`SELECT 1 FROM ${table} WHERE ${column} = ${userId}`,
            );
        }),
      );
    const result = await tx.execute(
      sql`SELECT 1 FROM (${sql.join(queries, sql` UNION ALL `)}) AS unsupported_user_references LIMIT 1`,
    );
    return result.rows.length > 0;
  }
}

// Deliberately explicit: new user-owned entities must be reviewed before an
// automatic reconciliation is allowed to move or delete their data.
const TRANSFER_COLUMNS = [
  schema.agentsTable.authorId,
  schema.conversationsTable.userId,
  schema.chatActiveRunsTable.userId,
  schema.filesTable.userId,
  schema.interactionsTable.userId,
  schema.mcpToolCallsTable.userId,
  schema.a2aTaskApprovalRequestsTable.reviewerUserId,
  schema.agentRunsTable.actorUserId,
  schema.a2aOutboundRunsTable.userId,
  schema.auditLogsTable.actorId,
  schema.auditLogsTable.impersonatedBy,
  schema.skillUsageEventsTable.userId,
  schema.externalMcpSkillUsageEventsTable.userId,
  schema.pluginSkillUsageEventsTable.userId,
  schema.conversationSharesTable.createdByUserId,
  schema.conversationAttachmentsTable.uploadedByUserId,
  schema.agentRunSharesTable.createdByUserId,
];

export default SsoPendingUserModel;
