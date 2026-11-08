// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type PermissionSubject,
  PredefinedRoleNameSchema,
  type ResourceAccessRelation,
  type ScopedResource,
  supportsOauthClientSubject,
} from "@archestra/shared";
import { and, eq, ilike, inArray, notInArray, or, sql } from "drizzle-orm";
import { requestScope } from "@/auth/request-scope";
import { SERVICE_ACCOUNT_USER_ID_PREFIX } from "@/auth/service-account-user-id";
import db, { schema } from "@/database";
import { readConfig } from "@/services/config-cache";
import type { AclEntry } from "@/types";
import MemberModel from "./member";
import RoleCompositionModel from "./role-composition";
import TeamModel from "./team";

/** A caller's grant subjects within one organization. */
export type GrantPrincipal = {
  organizationId: string;
  subjects: PermissionSubject[];
  /** Creator/owner user ID when the principal is a managed OAuth client. */
  authorId?: string | null;
  /** Creator/owner email when the principal is a managed OAuth client. */
  authorEmail?: string | null;
  /**
   * Upstream ACL tokens (`user_email:<email>`, `team:<id>`) inherited from the
   * creator/owner of a managed OAuth client for source-permission-synced
   * connectors.
   */
  upstreamTokens?: AclEntry[];
};

/**
 * A list's "Show" filter with the caller's subjects resolved, in the shape
 * `ResourcePermissionPolicyModel.accessRelationCondition` takes.
 */
export type ResourceAccessFilter = {
  userId: string;
  subjects: PermissionSubject[];
} & ResourceAccessSelection;

/**
 * What a list's `access`, `sharedWith`, and `owner` query parameters
 * selected, before the caller's subjects are resolved. Every part is
 * optional; see `ResourcePermissionPolicyModel.accessRelationCondition`.
 */
export type ResourceAccessSelection = {
  relations?: ResourceAccessRelation[];
  sharedWith?: PermissionSubject[];
  ownerIds?: string[];
};

/**
 * The selection a list's query parameters make, or undefined when none of
 * them filters, so a list that predates them keeps its unfiltered path.
 */
export function resourceAccessSelection(query: {
  access?: ResourceAccessRelation[];
  sharedWith?: PermissionSubject[];
  owner?: string[];
}): ResourceAccessSelection | undefined {
  if (
    !query.access?.length &&
    !query.sharedWith?.length &&
    !query.owner?.length
  )
    return undefined;
  return {
    relations: query.access,
    sharedWith: query.sharedWith,
    ownerIds: query.owner,
  };
}

/** Resolves principals; a request passes one that resolves each caller once. */
export type PrincipalSource = {
  principal(params: {
    userId: string;
    organizationId: string;
  }): Promise<GrantPrincipal>;
};

export default class ResourcePermissionSubjectModel {
  /** {@link resolvePrincipal} through the request's source when it has one. */
  static resolvePrincipalFrom(
    source: PrincipalSource | undefined,
    params: { userId: string; organizationId: string },
  ): Promise<GrantPrincipal> {
    return source
      ? source.principal(params)
      : ResourcePermissionSubjectModel.resolvePrincipal(params);
  }

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
    return requestScope.memo(
      `principal\0${params.organizationId}\0${params.userId}`,
      async () => ({
        organizationId: params.organizationId,
        subjects: await readConfig(
          `principal-subjects\0${params.organizationId}\0${params.userId}`,
          () => ResourcePermissionSubjectModel.resolveSubjects(params),
        ),
      }),
    );
  }

  /**
   * {@link resolvePrincipal} in the given organization, or in every
   * organization the caller belongs to for a query that is not fenced to one.
   */
  static async resolvePrincipals(params: {
    userId: string;
    organizationId?: string;
    lookups?: PrincipalSource;
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
        ResourcePermissionSubjectModel.resolvePrincipalFrom(params.lookups, {
          userId,
          organizationId: id,
        }),
      ),
    );
    return principals.filter((principal) => principal.subjects.length > 0);
  }

  /**
   * The caller's subjects for a list's `access`, `sharedWith`, and `owner`
   * filters, resolved once so a page query and its count share them.
   * Undefined when none of them filters the list.
   */
  static async resolveAccessFilter(params: {
    userId: string;
    organizationId: string;
    relations?: ResourceAccessRelation[];
    sharedWith?: PermissionSubject[];
    ownerIds?: string[];
  }): Promise<ResourceAccessFilter | undefined> {
    const selection = resourceAccessSelection({
      access: params.relations,
      sharedWith: params.sharedWith,
      owner: params.ownerIds,
    });
    if (!selection) return undefined;
    const principal = await ResourcePermissionSubjectModel.resolvePrincipal({
      userId: params.userId,
      organizationId: params.organizationId,
    });
    return {
      userId: params.userId,
      subjects: principal.subjects,
      ...selection,
    };
  }

  /**
   * The grant subjects of an active managed OAuth client in its organization,
   * or null when the client does not exist, is disabled, or belongs to another
   * organization. Accepts either the row `id` or the OAuth `client_id`.
   */
  static async resolveOauthClientPrincipal(params: {
    oauthClientId: string;
    organizationId?: string;
  }): Promise<GrantPrincipal | null> {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        params.oauthClientId,
      );
    const [client] = await db
      .select({
        id: schema.oauthClientsTable.id,
        organizationId: sql<
          string | null
        >`${schema.oauthClientsTable.metadata}->>'organizationId'`,
        authorId: sql<
          string | null
        >`${schema.oauthClientsTable.metadata}->>'authorId'`,
      })
      .from(schema.oauthClientsTable)
      .where(
        and(
          isUuid
            ? or(
                eq(schema.oauthClientsTable.id, params.oauthClientId),
                eq(schema.oauthClientsTable.clientId, params.oauthClientId),
              )
            : eq(schema.oauthClientsTable.clientId, params.oauthClientId),
          sql`${schema.oauthClientsTable.metadata}->>'type' = 'managed_oauth_client'`,
          sql`COALESCE(${schema.oauthClientsTable.disabled}, false) = false`,
          ...(params.organizationId
            ? [
                sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
              ]
            : []),
        ),
      )
      .limit(1);
    if (!client?.organizationId) return null;
    let authorId: string | null = null;
    let authorEmail: string | null = null;
    let upstreamTokens: AclEntry[] = [];
    if (client.authorId) {
      const [author] = await db
        .select({
          id: schema.usersTable.id,
          email: schema.usersTable.email,
        })
        .from(schema.usersTable)
        .innerJoin(
          schema.membersTable,
          and(
            eq(schema.membersTable.userId, schema.usersTable.id),
            eq(schema.membersTable.organizationId, client.organizationId),
          ),
        )
        .where(eq(schema.usersTable.id, client.authorId))
        .limit(1);
      if (author) {
        authorId = author.id;
        authorEmail = author.email ?? null;
        const teams = await TeamModel.getUserTeamsForOrganization({
          userId: author.id,
          organizationId: client.organizationId,
        });
        upstreamTokens = [
          ...(author.email
            ? ([`user_email:${author.email.trim().toLowerCase()}`] as const)
            : []),
          ...teams.map((team): AclEntry => `team:${team.id}`),
        ];
      }
    }
    return {
      organizationId: client.organizationId,
      subjects: [
        { type: "organization", id: "*" },
        { type: "oauthClient", id: client.id },
      ],
      authorId,
      authorEmail,
      upstreamTokens,
    };
  }

  static async search(params: {
    organizationId: string;
    query: string;
    resource?: ScopedResource;
    exclude?: PermissionSubject[];
    excludedUserRoles?: string[];
  }) {
    const excludedIds = (type: PermissionSubject["type"]) =>
      params.exclude
        ?.filter((subject) => subject.type === type)
        .map((subject) => subject.id) ?? [];
    const pattern = `%${params.query.replace(/[\\%_]/g, "\\$&")}%`;
    const includeOauthClients =
      !params.resource || supportsOauthClientSubject(params.resource);
    const [users, teams, accounts, oauthClients, roles] = await Promise.all([
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
            notInArray(schema.usersTable.id, excludedIds("user")),
            notInArray(
              schema.membersTable.role,
              params.excludedUserRoles ?? [],
            ),
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
            notInArray(schema.teamsTable.id, excludedIds("team")),
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
            notInArray(
              schema.serviceAccountsTable.id,
              excludedIds("serviceAccount"),
            ),
            ilike(schema.serviceAccountsTable.name, pattern),
          ),
        )
        .orderBy(schema.serviceAccountsTable.name)
        .limit(30),
      includeOauthClients
        ? db
            .select({
              id: schema.oauthClientsTable.id,
              name: schema.oauthClientsTable.name,
              clientId: schema.oauthClientsTable.clientId,
            })
            .from(schema.oauthClientsTable)
            .where(
              and(
                sql`${schema.oauthClientsTable.metadata}->>'type' = 'managed_oauth_client'`,
                sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
                sql`COALESCE(${schema.oauthClientsTable.disabled}, false) = false`,
                notInArray(
                  schema.oauthClientsTable.id,
                  excludedIds("oauthClient"),
                ),
                ilike(schema.oauthClientsTable.name, pattern),
              ),
            )
            .orderBy(schema.oauthClientsTable.name)
            .limit(30)
        : Promise.resolve([]),
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
            notInArray(schema.organizationRolesTable.id, excludedIds("role")),
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
      ...oauthClients.map((client) => ({
        subject: { type: "oauthClient" as const, id: client.id },
        name: client.name ?? client.clientId,
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
    const oauthClientIds = ids("oauthClient");
    const [users, teams, accounts, oauthClients, roles] = await Promise.all([
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
      oauthClientIds.length
        ? db
            .select({
              id: schema.oauthClientsTable.id,
              name: schema.oauthClientsTable.name,
              clientId: schema.oauthClientsTable.clientId,
            })
            .from(schema.oauthClientsTable)
            .where(
              and(
                sql`${schema.oauthClientsTable.metadata}->>'type' = 'managed_oauth_client'`,
                sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
                sql`COALESCE(${schema.oauthClientsTable.disabled}, false) = false`,
                inArray(schema.oauthClientsTable.id, oauthClientIds),
              ),
            )
        : Promise.resolve([]),
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
      ...oauthClients.map(({ id, name, clientId }) => ({
        type: "oauthClient" as const,
        id,
        name: name ?? clientId,
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
          teamId: schema.serviceAccountsTable.teamId,
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
      // An account acting for a team is reached by that team's grants, and
      // its ancestors', the same way a member is. The team's roles are not
      // inherited: the account's own role says what its keys may do.
      if (account.teamId) {
        const teams = await RoleCompositionModel.getTeamSources({
          organizationId: params.organizationId,
          teamId: account.teamId,
        });
        subjects.push(
          ...teams.map(({ id }) => ({ type: "team" as const, id })),
        );
      }
      identifiers = account.role.split(",");
    } else {
      const member = await MemberModel.getByUserId(
        params.userId,
        params.organizationId,
      );
      if (!member) return [];
      const [teamIds, sources] = await Promise.all([
        requestScope.isMemoizing()
          ? TeamModel.getUserTeamContext(params).then(
              (context) => context.subjectTeamIds,
            )
          : TeamModel.getUserTeamIds(params.userId),
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
