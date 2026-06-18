import { randomBytes } from "node:crypto";
import {
  MCP_GATEWAY_OAUTH_SCOPE,
  MCP_OAUTH_CLIENT_ID_PREFIX,
} from "@archestra/shared";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq, ilike, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  MCP_OAUTH_CLIENT_METADATA_TYPE,
  McpOauthClientMetadataSchema,
} from "@/types/mcp-oauth-client";
import { escapeLikePattern } from "@/utils/sql-search";

class McpOauthClientModel {
  static async findAllByOrganization(params: {
    organizationId: string;
    search?: string;
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
        ),
      )
      .orderBy(schema.oauthClientsTable.createdAt);

    return hydrateOauthClients(rows);
  }

  static async create(params: {
    organizationId: string;
    name: string;
    allowedGatewayIds: string[];
  }) {
    const clientSecret = createClientSecret();
    const clientSecretHash = await hashClientSecret(clientSecret);
    const metadata = {
      type: MCP_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: params.organizationId,
      allowedGatewayIds: params.allowedGatewayIds,
    };

    const [client] = await db
      .insert(schema.oauthClientsTable)
      .values({
        id: crypto.randomUUID(),
        clientId: `${MCP_OAUTH_CLIENT_ID_PREFIX}${randomBytes(18).toString("base64url")}`,
        clientSecret: clientSecretHash,
        name: params.name,
        redirectUris: [],
        tokenEndpointAuthMethod: "client_secret_post",
        grantTypes: ["client_credentials"],
        responseTypes: [],
        public: false,
        scopes: [MCP_GATEWAY_OAUTH_SCOPE],
        type: "service",
        metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return {
      oauthClient: hydrateOauthClients([client])[0],
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

    return client ? (hydrateOauthClients([client])[0] ?? null) : null;
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
    return hydrateOauthClients([client])[0] ?? null;
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

    return hydrateOauthClients([client])[0] ?? null;
  }

  static async rotateSecret(params: { id: string; organizationId: string }) {
    const clientSecret = createClientSecret();
    const [client] = await db
      .update(schema.oauthClientsTable)
      .set({
        clientSecret: await hashClientSecret(clientSecret),
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
      oauthClient: hydrateOauthClients([client])[0],
      clientSecret,
    };
  }

  static async update(params: {
    id: string;
    organizationId: string;
    name: string;
    allowedGatewayIds: string[];
  }) {
    const metadata = {
      type: MCP_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: params.organizationId,
      allowedGatewayIds: params.allowedGatewayIds,
    };

    const [client] = await db
      .update(schema.oauthClientsTable)
      .set({
        name: params.name,
        metadata,
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

    return client ? (hydrateOauthClients([client])[0] ?? null) : null;
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
      allowedGatewayIds: [...client.allowedGatewayIds].sort(),
      disabled: client.disabled,
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

function hydrateOauthClients(
  clients: Array<typeof schema.oauthClientsTable.$inferSelect>,
) {
  return clients.flatMap((client) => {
    const metadata = McpOauthClientMetadataSchema.safeParse(
      client.metadata,
    ).data;
    if (!metadata) return [];
    return [
      {
        id: client.id,
        clientId: client.clientId,
        name: client.name ?? client.clientId,
        organizationId: metadata.organizationId,
        allowedGatewayIds: metadata.allowedGatewayIds,
        disabled: client.disabled ?? false,
        createdAt: client.createdAt,
        updatedAt: client.updatedAt,
      },
    ];
  });
}
