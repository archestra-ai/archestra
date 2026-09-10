// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { PermissionSubject } from "@archestra/shared";
import { and, eq, ilike, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

export default class ResourcePermissionSubjectModel {
  /** Snapshot the legacy inputs in four queries, independent of actor count. */
  static async getLegacyAccessInputs(organizationId: string) {
    const [members, accounts, teams, memberships] = await Promise.all([
      db
        .select({
          id: schema.usersTable.id,
          name: schema.usersTable.name,
          role: schema.membersTable.role,
        })
        .from(schema.membersTable)
        .innerJoin(
          schema.usersTable,
          eq(schema.usersTable.id, schema.membersTable.userId),
        )
        .where(eq(schema.membersTable.organizationId, organizationId)),
      db
        .select({
          id: schema.serviceAccountsTable.id,
          name: schema.serviceAccountsTable.name,
          role: schema.serviceAccountsTable.role,
        })
        .from(schema.serviceAccountsTable)
        .where(
          and(
            eq(schema.serviceAccountsTable.organizationId, organizationId),
            eq(schema.serviceAccountsTable.disabled, false),
          ),
        ),
      db
        .select({
          id: schema.teamsTable.id,
          parentId: schema.teamsTable.parentId,
          roles: schema.teamsTable.roles,
        })
        .from(schema.teamsTable)
        .where(eq(schema.teamsTable.organizationId, organizationId)),
      db
        .select({
          userId: schema.teamMembersTable.userId,
          teamId: schema.teamMembersTable.teamId,
          role: schema.teamMembersTable.role,
        })
        .from(schema.teamMembersTable)
        .innerJoin(
          schema.teamsTable,
          eq(schema.teamsTable.id, schema.teamMembersTable.teamId),
        )
        .where(eq(schema.teamsTable.organizationId, organizationId)),
    ]);
    return { members, accounts, teams, memberships };
  }

  static async search(params: { organizationId: string; query: string }) {
    const pattern = `%${params.query.replace(/[\\%_]/g, "\\$&")}%`;
    const [users, teams, accounts, roles] = await Promise.all([
      db
        .select({ id: schema.usersTable.id, name: schema.usersTable.name })
        .from(schema.usersTable)
        .innerJoin(
          schema.membersTable,
          eq(schema.membersTable.userId, schema.usersTable.id),
        )
        .where(
          and(
            eq(schema.membersTable.organizationId, params.organizationId),
            ilike(schema.usersTable.name, pattern),
          ),
        )
        .orderBy(schema.usersTable.name)
        .limit(30),
      db
        .select({ id: schema.teamsTable.id, name: schema.teamsTable.name })
        .from(schema.teamsTable)
        .where(
          and(
            eq(schema.teamsTable.organizationId, params.organizationId),
            ilike(schema.teamsTable.name, pattern),
          ),
        )
        .orderBy(schema.teamsTable.name)
        .limit(30),
      db
        .select({
          id: schema.serviceAccountsTable.id,
          name: schema.serviceAccountsTable.name,
        })
        .from(schema.serviceAccountsTable)
        .where(
          and(
            eq(
              schema.serviceAccountsTable.organizationId,
              params.organizationId,
            ),
            eq(schema.serviceAccountsTable.disabled, false),
            ilike(schema.serviceAccountsTable.name, pattern),
          ),
        )
        .orderBy(schema.serviceAccountsTable.name)
        .limit(30),
      db
        .select({
          id: schema.organizationRolesTable.id,
          name: schema.organizationRolesTable.name,
        })
        .from(schema.organizationRolesTable)
        .where(
          and(
            eq(
              schema.organizationRolesTable.organizationId,
              params.organizationId,
            ),
            ilike(schema.organizationRolesTable.name, pattern),
          ),
        )
        .orderBy(schema.organizationRolesTable.name)
        .limit(30),
    ]);
    return [
      ...users.map((user) => ({
        subject: { type: "user" as const, id: user.id },
        name: user.name,
      })),
      ...teams.map((team) => ({
        subject: { type: "team" as const, id: team.id },
        name: team.name,
      })),
      ...accounts.map((account) => ({
        subject: { type: "serviceAccount" as const, id: account.id },
        name: account.name,
      })),
      ...roles.map((role) => ({
        subject: { type: "role" as const, id: role.id },
        name: role.name,
      })),
    ];
  }
  /** Validate live recipients inside the organization; never trust picker input. */
  static async findExisting(params: {
    organizationId: string;
    subjects: PermissionSubject[];
  }): Promise<Array<PermissionSubject & { name: string }>> {
    const ids = (type: PermissionSubject["type"]) =>
      params.subjects
        .filter((subject) => subject.type === type)
        .map((subject) => subject.id);
    const [users, teams, accounts, roles] = await Promise.all([
      db
        .select({
          id: schema.membersTable.userId,
          name: schema.usersTable.name,
        })
        .from(schema.membersTable)
        .innerJoin(
          schema.usersTable,
          eq(schema.usersTable.id, schema.membersTable.userId),
        )
        .where(
          and(
            eq(schema.membersTable.organizationId, params.organizationId),
            inArray(schema.membersTable.userId, ids("user")),
          ),
        ),
      db
        .select({ id: schema.teamsTable.id, name: schema.teamsTable.name })
        .from(schema.teamsTable)
        .where(
          and(
            eq(schema.teamsTable.organizationId, params.organizationId),
            inArray(schema.teamsTable.id, ids("team")),
          ),
        ),
      db
        .select({
          id: schema.serviceAccountsTable.id,
          name: schema.serviceAccountsTable.name,
        })
        .from(schema.serviceAccountsTable)
        .where(
          and(
            eq(
              schema.serviceAccountsTable.organizationId,
              params.organizationId,
            ),
            inArray(schema.serviceAccountsTable.id, ids("serviceAccount")),
            eq(schema.serviceAccountsTable.disabled, false),
          ),
        ),
      db
        .select({
          id: schema.organizationRolesTable.id,
          name: schema.organizationRolesTable.name,
        })
        .from(schema.organizationRolesTable)
        .where(
          and(
            eq(
              schema.organizationRolesTable.organizationId,
              params.organizationId,
            ),
            inArray(schema.organizationRolesTable.id, ids("role")),
          ),
        ),
    ]);
    return [
      ...users.map(({ id, name }) => ({ type: "user" as const, id, name })),
      ...teams.map(({ id, name }) => ({ type: "team" as const, id, name })),
      ...accounts.map(({ id, name }) => ({
        type: "serviceAccount" as const,
        id,
        name,
      })),
      ...roles.map(({ id, name }) => ({ type: "role" as const, id, name })),
    ];
  }

  static async getRoleIds(params: {
    organizationId: string;
    identifiers: string[];
  }) {
    return db
      .select({
        id: schema.organizationRolesTable.id,
        role: schema.organizationRolesTable.role,
      })
      .from(schema.organizationRolesTable)
      .where(
        and(
          eq(
            schema.organizationRolesTable.organizationId,
            params.organizationId,
          ),
          inArray(schema.organizationRolesTable.role, params.identifiers),
        ),
      );
  }
}
