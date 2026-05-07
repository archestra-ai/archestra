import { randomBytes } from "node:crypto";
import { LLM_PROXY_OAUTH_SCOPE } from "@shared";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  LLM_OAUTH_CLIENT_METADATA_TYPE,
  LlmOauthClientMetadataSchema,
  type LlmOauthClientProviderKey,
} from "@/types/llm-oauth-client";

class LlmOauthClientModel {
  static async findAllByOrganization(organizationId: string) {
    const rows = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(
        sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}
          AND ${schema.oauthClientsTable.metadata}->>'organizationId' = ${organizationId}`,
      )
      .orderBy(schema.oauthClientsTable.createdAt);

    return hydrateOauthClients(rows);
  }

  static async create(params: {
    organizationId: string;
    name: string;
    allowedLlmProxyIds: string[];
    providerApiKeys: LlmOauthClientProviderKey[];
  }) {
    const clientSecret = createClientSecret();
    const clientSecretHash = await hashClientSecret(clientSecret);
    const metadata = {
      type: LLM_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: params.organizationId,
      allowedLlmProxyIds: params.allowedLlmProxyIds,
      providerApiKeys: params.providerApiKeys,
    };

    const [client] = await db
      .insert(schema.oauthClientsTable)
      .values({
        id: crypto.randomUUID(),
        clientId: `llm_oauth_${randomBytes(18).toString("base64url")}`,
        clientSecret: clientSecretHash,
        name: params.name,
        redirectUris: [],
        tokenEndpointAuthMethod: "client_secret_post",
        grantTypes: ["client_credentials"],
        responseTypes: [],
        public: false,
        scopes: [LLM_PROXY_OAUTH_SCOPE],
        type: "service",
        metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

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
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
        ),
      )
      .limit(1);

    return client ? (await hydrateOauthClients([client]))[0] : null;
  }

  static async findByClientId(clientId: string) {
    const [client] = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(
        and(
          eq(schema.oauthClientsTable.clientId, clientId),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
        ),
      )
      .limit(1);

    return client ? (await hydrateOauthClients([client]))[0] : null;
  }

  static async findByProviderApiKeyId(params: {
    providerApiKeyId: string;
    organizationId: string;
  }) {
    const clients = await LlmOauthClientModel.findAllByOrganization(
      params.organizationId,
    );
    return clients.filter((client) =>
      client.providerApiKeys.some(
        (mapping) => mapping.providerApiKeyId === params.providerApiKeyId,
      ),
    );
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
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
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
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
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
    allowedLlmProxyIds: string[];
    providerApiKeys: LlmOauthClientProviderKey[];
  }) {
    const metadata = {
      type: LLM_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: params.organizationId,
      allowedLlmProxyIds: params.allowedLlmProxyIds,
      providerApiKeys: params.providerApiKeys,
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
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
        ),
      )
      .returning();

    return client ? (await hydrateOauthClients([client]))[0] : null;
  }

  static async delete(params: { id: string; organizationId: string }) {
    const result = await db
      .delete(schema.oauthClientsTable)
      .where(
        and(
          eq(schema.oauthClientsTable.id, params.id),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
        ),
      )
      .returning({ id: schema.oauthClientsTable.id });

    return result.length > 0;
  }
}

export default LlmOauthClientModel;

function createClientSecret() {
  return `llm_secret_${randomBytes(32).toString("base64url")}`;
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
  const providerApiKeyIds = [
    ...new Set(
      clients.flatMap((client) => {
        const metadata = LlmOauthClientMetadataSchema.safeParse(
          client.metadata,
        ).data;
        if (!metadata) return [];
        return metadata.providerApiKeys.map(
          (mapping) => mapping.providerApiKeyId,
        );
      }),
    ),
  ];
  const apiKeyRows =
    providerApiKeyIds.length > 0
      ? await db
          .select({
            id: schema.llmProviderApiKeysTable.id,
            name: schema.llmProviderApiKeysTable.name,
            provider: schema.llmProviderApiKeysTable.provider,
          })
          .from(schema.llmProviderApiKeysTable)
          .where(inArray(schema.llmProviderApiKeysTable.id, providerApiKeyIds))
      : [];
  const apiKeyNames = new Map(apiKeyRows.map((row) => [row.id, row.name]));

  return clients.flatMap((client) => {
    const metadata = LlmOauthClientMetadataSchema.safeParse(
      client.metadata,
    ).data;
    if (!metadata) return [];
    return [
      {
        id: client.id,
        clientId: client.clientId,
        name: client.name ?? client.clientId,
        organizationId: metadata.organizationId,
        allowedLlmProxyIds: metadata.allowedLlmProxyIds,
        providerApiKeys: metadata.providerApiKeys.map((mapping) => ({
          ...mapping,
          providerApiKeyName:
            apiKeyNames.get(mapping.providerApiKeyId) ??
            mapping.providerApiKeyId,
        })),
        disabled: client.disabled ?? false,
        createdAt: client.createdAt,
        updatedAt: client.updatedAt,
      },
    ];
  });
}
