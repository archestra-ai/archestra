// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type PermissionSubject,
  PredefinedRoleNameSchema,
} from "@archestra/shared";
import { and, eq, ilike, inArray, or } from "drizzle-orm";
import { SERVICE_ACCOUNT_USER_ID_PREFIX } from "@/auth/service-account-user-id";
import db, { schema } from "@/database";
import MemberModel from "./member";
import RoleCompositionModel from "./role-composition";
import TeamModel from "./team";

/** A caller's grant subjects within one organization. */
export type GrantPrincipal = {
  organizationId: string;
  subjects: PermissionSubject[];
};

export default class ResourcePermissionSubjectModel {
  /**
   * Every subject a grant can name to reach this caller: the organization,
   * the user or service account, its teams with their ancestors, and its roles
   * including those inherited through teams. Empty for a non-member or a
   * disabled service account, so no grant reaches them.
   */
  static async resolvePrincipal(params: {
    userId: string;
    organizationId: string;
  }): Promise<GrantPrincipal> {
    return {
      organizationId: params.organizationId,
      subjects: await ResourcePermissionSubjectModel.resolveSubjects(params),
    };
  }

  /**
   * {@link resolvePrincipal} in the given organization, or in every
   * organization the caller belongs to for a query that is not fenced to one.
   */
  static async resolvePrincipals(params: {
    userId: string;
    organizationId?: string;
  }): Promise<GrantPrincipal[]> {
    const { userId } = params;
    const organizationIds = params.organizationId
      ? [{ id: params.organizationId }]
      : userId.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX)
        ? await db
            .select({ id: schema.serviceAccountsTable.organizationId })
            .from(schema.serviceAccountsTable)
            .where(
              eq(
                schema.serviceAccountsTable.id,
                userId.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length),
              ),
            )
        : await db
            .selectDistinct({ id: schema.membersTable.organizationId })
            .from(schema.membersTable)
            .where(eq(schema.membersTable.userId, userId));
    const principals = await Promise.all(
      organizationIds.map(({ id }) =>
        ResourcePermissionSubjectModel.resolvePrincipal({
          userId,
          organizationId: id,
        }),
      ),
    );
    return principals.filter((principal) => principal.subjects.length > 0);
  }

  static async search(params: { organizationId: string; query: string }) {
    const pattern = `%${params.query.replace(/[\\%_]/g, "\\$&")}%`;
    const [users, teams, accounts, roles] = await Promise.all([
      db
        .select({
          id: schema.usersTable.id,
          name: schema.usersTable.name,
          email: schema.usersTable.email,
        })
        .from(schema.usersTable)
        .innerJoin(
          schema.membersTable,
          eq(schema.membersTable.userId, schema.usersTable.id),
        )
        .where(
          and(
            eq(schema.membersTable.organizationId, params.organizationId),
            or(
              ilike(schema.usersTable.name, pattern),
              ilike(schema.usersTable.email, pattern),
            ),
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
        email: user.email,
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

  private static async resolveSubjects(params: {
    userId: string;
    organizationId: string;
  }): Promise<PermissionSubject[]> {
    const subjects: PermissionSubject[] = [{ type: "organization", id: "*" }];
    let identifiers: string[];
    if (params.userId.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX)) {
      const id = params.userId.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length);
      const [account] = await db
        .select({
          role: schema.serviceAccountsTable.role,
          disabled: schema.serviceAccountsTable.disabled,
        })
        .from(schema.serviceAccountsTable)
        .where(
          and(
            eq(schema.serviceAccountsTable.id, id),
            eq(
              schema.serviceAccountsTable.organizationId,
              params.organizationId,
            ),
          ),
        )
        .limit(1);
      if (!account || account.disabled) return [];
      subjects.push({ type: "serviceAccount", id });
      identifiers = account.role.split(",");
    } else {
      const member = await MemberModel.getByUserId(
        params.userId,
        params.organizationId,
      );
      if (!member) return [];
      const [teamIds, sources] = await Promise.all([
        TeamModel.getUserTeamIds(params.userId),
        RoleCompositionModel.getUserSources(params),
      ]);
      subjects.push(
        { type: "user", id: params.userId },
        ...teamIds.map((id) => ({ type: "team" as const, id })),
      );
      identifiers = sources.map((source) => source.role);
    }
    const roles = await ResourcePermissionSubjectModel.getRoleIds({
      organizationId: params.organizationId,
      identifiers,
    });
    subjects.push(
      ...roles.map(({ id }) => ({ type: "role" as const, id })),
      ...identifiers
        .filter((id) => PredefinedRoleNameSchema.safeParse(id).success)
        .map((id) => ({ type: "role" as const, id })),
    );
    return subjects;
  }

  private static async getRoleIds(params: {
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
