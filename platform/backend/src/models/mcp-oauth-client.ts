import { randomBytes } from "node:crypto";
import {
  MCP_GATEWAY_OAUTH_SCOPE,
  MCP_OAUTH_CLIENT_ID_PREFIX,
  OFFLINE_ACCESS_OAUTH_SCOPE,
} from "@archestra/shared";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq, ilike, sql } from "drizzle-orm";
import { hashOauthClientSecret } from "@/auth/oauth-client-secret";
import db, { schema, withDbTransaction } from "@/database";
import {
  MCP_OAUTH_CLIENT_METADATA_TYPE,
  type McpOauthClientGrantType,
  McpOauthClientMetadataSchema,
} from "@/types/mcp-oauth-client";
import type { ResourceVisibilityScope } from "@/types/visibility";
import { escapeLikePattern } from "@/utils/sql-search";
import OauthClientTeamModel from "./oauth-client-team";
import UserModel from "./user";

class McpOauthClientModel {
  static async findAllByOrganization(params: {
    organizationId: string;
    search?: string;
    /**
     * Restricts results to clients the user may see (org-scoped, own personal,
     * teams they belong to). Omit only for internal callers that must see
     * everything; admin viewers are unfiltered.
     */
    viewer?: { userId: string; isAdmin: boolean };
  }) {
    const rows = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(
        and(
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${MCP_OAUTH_CLIENT_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
          params.search
            ? ilike(
                schema.oauthClientsTable.name,
                `%${escapeLikePattern(params.search.trim())}%`,
              )
            : undefined,
          params.viewer && !params.viewer.isAdmin
            ? OauthClientTeamModel.accessibleScopeCondition(
                params.viewer.userId,
              )
            : undefined,
        ),
      )
      .orderBy(schema.oauthClientsTable.createdAt);

    return hydrateOauthClients(rows);
  }

  static async create(params: {
    organizationId: string;
    name: string;
    grantType?: McpOauthClientGrantType;
    allowedGatewayIds?: string[];
    redirectUris?: string[];
    scope?: ResourceVisibilityScope;
    teams?: string[];
    authorId: string;
  }) {
    const grantType = params.grantType ?? "client_credentials";
    const isAuthorizationCode = grantType === "authorization_code";
    const clientSecret = createClientSecret();
    // authorization_code secrets are verified by better-auth (deterministic
    // hash); client_credentials secrets are verified by this model (bcrypt).
    const clientSecretHash = isAuthorizationCode
      ? hashOauthClientSecret(clientSecret)
      : await hashClientSecret(clientSecret);
    // allowedGatewayIds governs both grant types, but differently:
    // - client_credentials: the SOLE authority — the token may only reach
    //   gateways on this list (there is no acting user).
    // - authorization_code: an ADDITIVE, admin-controlled grant — a user who
    //   authenticates through this client may reach these gateways IN ADDITION
    //   to whatever their own RBAC already allows. Empty = pure identity
    //   passthrough (the original behavior).
    const metadata = {
      type: MCP_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: params.organizationId,
      grantType,
      allowedGatewayIds: params.allowedGatewayIds ?? [],
      scope: params.scope ?? "personal",
      authorId: params.authorId,
    };
    const teams = params.teams ?? [];

    const client = await withDbTransaction(async (tx) => {
      const [row] = await tx
        .insert(schema.oauthClientsTable)
        .values({
          id: crypto.randomUUID(),
          clientId: `${MCP_OAUTH_CLIENT_ID_PREFIX}${randomBytes(18).toString("base64url")}`,
          clientSecret: clientSecretHash,
          name: params.name,
          // authorization_code is a confidential client (client_secret_post) that
          // additionally requires PKCE; its tokens flow through better-auth's
          // standard authorize→token exchange and are user-bound.
          redirectUris: isAuthorizationCode ? (params.redirectUris ?? []) : [],
          tokenEndpointAuthMethod: "client_secret_post",
          grantTypes: isAuthorizationCode
            ? ["authorization_code", "refresh_token"]
            : ["client_credentials"],
          responseTypes: isAuthorizationCode ? ["code"] : [],
          requirePKCE: isAuthorizationCode,
          public: false,
          scopes: isAuthorizationCode
            ? [MCP_GATEWAY_OAUTH_SCOPE, OFFLINE_ACCESS_OAUTH_SCOPE]
            : [MCP_GATEWAY_OAUTH_SCOPE],
          type: "service",
          metadata,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      if (teams.length > 0) {
        await OauthClientTeamModel.syncTeams(row.id, teams, tx);
      }
      return row;
    });

    return {
      oauthClient: (await hydrateOauthClients([client]))[0],
      clientSecret,
    };
  }

  static async findById(params: { id: string; organizationId: string }) {
    const [client] = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(
        and(
          eq(schema.oauthClientsTable.id, params.id),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${MCP_OAUTH_CLIENT_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
        ),
      )
      .limit(1);

    return client ? ((await hydrateOauthClients([client]))[0] ?? null) : null;
  }

  static async findByClientId(clientId: string) {
    const [client] = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(
        and(
          eq(schema.oauthClientsTable.clientId, clientId),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${MCP_OAUTH_CLIENT_METADATA_TYPE}`,
        ),
      )
      .limit(1);

    if (!client || client.disabled) {
      return null;
    }
    return (await hydrateOauthClients([client]))[0] ?? null;
  }

  static async findClientForCredentials(params: {
    clientId: string;
    clientSecret: string;
  }) {
    const [client] = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(
        and(
          eq(schema.oauthClientsTable.clientId, params.clientId),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${MCP_OAUTH_CLIENT_METADATA_TYPE}`,
        ),
      )
      .limit(1);

    if (!client?.clientSecret || client.disabled) {
      return null;
    }
    if (
      !(await compareClientSecret(params.clientSecret, client.clientSecret))
    ) {
      return null;
    }

    return (await hydrateOauthClients([client]))[0] ?? null;
  }

  static async rotateSecret(params: { id: string; organizationId: string }) {
    // Hash the new secret with the scheme this client's grant type uses.
    const existing = await McpOauthClientModel.findById(params);
    if (!existing) return null;
    const clientSecret = createClientSecret();
    const clientSecretHash =
      existing.grantType === "authorization_code"
        ? hashOauthClientSecret(clientSecret)
        : await hashClientSecret(clientSecret);
    const [client] = await db
      .update(schema.oauthClientsTable)
      .set({
        clientSecret: clientSecretHash,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.oauthClientsTable.id, params.id),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${MCP_OAUTH_CLIENT_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
        ),
      )
      .returning();

    if (!client) return null;
    return {
      oauthClient: (await hydrateOauthClients([client]))[0],
      clientSecret,
    };
  }

  static async update(params: {
    id: string;
    organizationId: string;
    name: string;
    allowedGatewayIds?: string[];
    redirectUris?: string[];
    scope?: ResourceVisibilityScope;
    /** `undefined` leaves team assignments untouched; `[]` clears them. */
    teams?: string[];
  }) {
    // The grant type is fixed at creation; reload the client to preserve it and
    // to apply only the fields that grant type actually uses.
    const existing = await McpOauthClientModel.findById({
      id: params.id,
      organizationId: params.organizationId,
    });
    if (!existing) return null;
    const isAuthorizationCode = existing.grantType === "authorization_code";

    // allowedGatewayIds applies to both grant types (see create()); update it
    // for either, falling back to the existing value when omitted. The author
    // is fixed at creation; scope falls back to the existing value.
    const metadata = {
      type: MCP_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: params.organizationId,
      grantType: existing.grantType,
      allowedGatewayIds: params.allowedGatewayIds ?? existing.allowedGatewayIds,
      scope: params.scope ?? existing.scope,
      authorId: existing.authorId,
    };

    const client = await withDbTransaction(async (tx) => {
      const [row] = await tx
        .update(schema.oauthClientsTable)
        .set({
          name: params.name,
          metadata,
          ...(isAuthorizationCode
            ? { redirectUris: params.redirectUris ?? existing.redirectUris }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.oauthClientsTable.id, params.id),
            sql`${schema.oauthClientsTable.metadata}->>'type' = ${MCP_OAUTH_CLIENT_METADATA_TYPE}`,
            sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
          ),
        )
        .returning();

      if (row && params.teams !== undefined) {
        await OauthClientTeamModel.syncTeams(row.id, params.teams, tx);
      }
      return row;
    });

    return client ? ((await hydrateOauthClients([client]))[0] ?? null) : null;
  }

  static async delete(params: { id: string; organizationId: string }) {
    const result = await db
      .delete(schema.oauthClientsTable)
      .where(
        and(
          eq(schema.oauthClientsTable.id, params.id),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${MCP_OAUTH_CLIENT_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
        ),
      )
      .returning({ id: schema.oauthClientsTable.id });

    return result.length > 0;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const client = await McpOauthClientModel.findById({ id, organizationId });
    if (!client) return null;

    return {
      id: client.id,
      name: client.name,
      clientId: client.clientId,
      organizationId: client.organizationId,
      grantType: client.grantType,
      allowedGatewayIds: [...client.allowedGatewayIds].sort(),
      redirectUris: [...client.redirectUris].sort(),
      disabled: client.disabled,
      scope: client.scope,
      authorId: client.authorId,
      teamIds: client.teams.map((team) => team.id).sort(),
      createdAt: client.createdAt.toISOString(),
      updatedAt: client.updatedAt.toISOString(),
    };
  }
}

export default McpOauthClientModel;

function createClientSecret() {
  return `mcp_secret_${randomBytes(32).toString("base64url")}`;
}

function hashClientSecret(secret: string) {
  return hashPassword(secret);
}

function compareClientSecret(secret: string, storedHash: string) {
  return verifyPassword({ password: secret, hash: storedHash });
}

async function hydrateOauthClients(
  clients: Array<typeof schema.oauthClientsTable.$inferSelect>,
) {
  const parsed = clients.map((client) => ({
    client,
    metadata: McpOauthClientMetadataSchema.safeParse(client.metadata).data,
  }));

  // Only fetch what the rows actually reference so the runtime token paths
  // (org-scoped, authorless clients) stay free of extra queries.
  const teamScopedIds = parsed
    .filter(({ metadata }) => metadata?.scope === "team")
    .map(({ client }) => client.id);
  const authorIds = [
    ...new Set(
      parsed.flatMap(({ metadata }) =>
        metadata?.authorId ? [metadata.authorId] : [],
      ),
    ),
  ];
  const [teamsMap, authorNames] = await Promise.all([
    OauthClientTeamModel.getTeamDetailsForClients(teamScopedIds),
    UserModel.getNamesByIds(authorIds),
  ]);

  return parsed.flatMap(({ client, metadata }) => {
    if (!metadata) return [];
    return [
      {
        id: client.id,
        clientId: client.clientId,
        name: client.name ?? client.clientId,
        organizationId: metadata.organizationId,
        grantType: metadata.grantType,
        allowedGatewayIds: metadata.allowedGatewayIds,
        redirectUris: client.redirectUris ?? [],
        disabled: client.disabled ?? false,
        scope: metadata.scope,
        authorId: metadata.authorId,
        authorName: metadata.authorId
          ? (authorNames.get(metadata.authorId) ?? null)
          : null,
        teams: teamsMap.get(client.id) ?? [],
        createdAt: client.createdAt,
        updatedAt: client.updatedAt,
      },
    ];
  });
}
