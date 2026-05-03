import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  LLM_APPLICATION_METADATA_TYPE,
  LLM_MODEL_ROUTER_SCOPE,
  LlmApplicationMetadataSchema,
  type LlmApplicationProviderKey,
} from "@/types/llm-application";

class LlmApplicationModel {
  static async findAllByOrganization(organizationId: string) {
    const rows = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(
        sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_APPLICATION_METADATA_TYPE}
          AND ${schema.oauthClientsTable.metadata}->>'organizationId' = ${organizationId}`,
      )
      .orderBy(schema.oauthClientsTable.createdAt);

    return hydrateApplications(rows);
  }

  static async create(params: {
    organizationId: string;
    name: string;
    allowedLlmProxyIds: string[];
    modelRouterProviderApiKeys: LlmApplicationProviderKey[];
  }) {
    const clientSecret = createClientSecret();
    const clientSecretHash = hashClientSecret(clientSecret);
    const metadata = {
      type: LLM_APPLICATION_METADATA_TYPE,
      organizationId: params.organizationId,
      allowedLlmProxyIds: params.allowedLlmProxyIds,
      modelRouterProviderApiKeys: params.modelRouterProviderApiKeys,
    };

    const [client] = await db
      .insert(schema.oauthClientsTable)
      .values({
        id: crypto.randomUUID(),
        clientId: `llm_app_${randomBytes(18).toString("base64url")}`,
        clientSecret: clientSecretHash,
        name: params.name,
        redirectUris: [],
        tokenEndpointAuthMethod: "client_secret_post",
        grantTypes: ["client_credentials"],
        responseTypes: [],
        public: false,
        scopes: [LLM_MODEL_ROUTER_SCOPE],
        type: "service",
        metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return {
      application: (await hydrateApplications([client]))[0],
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
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_APPLICATION_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
        ),
      )
      .limit(1);

    return client ? (await hydrateApplications([client]))[0] : null;
  }

  static async findByClientId(clientId: string) {
    const [client] = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(
        and(
          eq(schema.oauthClientsTable.clientId, clientId),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_APPLICATION_METADATA_TYPE}`,
        ),
      )
      .limit(1);

    return client ? (await hydrateApplications([client]))[0] : null;
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
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_APPLICATION_METADATA_TYPE}`,
        ),
      )
      .limit(1);

    if (!client?.clientSecret || client.disabled) {
      return null;
    }
    if (!compareClientSecret(params.clientSecret, client.clientSecret)) {
      return null;
    }

    return (await hydrateApplications([client]))[0] ?? null;
  }

  static async rotateSecret(params: { id: string; organizationId: string }) {
    const clientSecret = createClientSecret();
    const [client] = await db
      .update(schema.oauthClientsTable)
      .set({
        clientSecret: hashClientSecret(clientSecret),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.oauthClientsTable.id, params.id),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_APPLICATION_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
        ),
      )
      .returning();

    if (!client) return null;
    return {
      application: (await hydrateApplications([client]))[0],
      clientSecret,
    };
  }

  static async delete(params: { id: string; organizationId: string }) {
    const result = await db
      .delete(schema.oauthClientsTable)
      .where(
        and(
          eq(schema.oauthClientsTable.id, params.id),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_APPLICATION_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
        ),
      )
      .returning({ id: schema.oauthClientsTable.id });

    return result.length > 0;
  }
}

export default LlmApplicationModel;

function createClientSecret() {
  return `llm_secret_${randomBytes(32).toString("base64url")}`;
}

function hashClientSecret(secret: string) {
  return createHash("sha256").update(secret).digest("base64url");
}

function compareClientSecret(secret: string, storedHash: string) {
  const candidate = Buffer.from(hashClientSecret(secret));
  const expected = Buffer.from(storedHash);
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

async function hydrateApplications(
  clients: Array<typeof schema.oauthClientsTable.$inferSelect>,
) {
  const chatApiKeyIds = [
    ...new Set(
      clients.flatMap((client) => {
        const metadata = LlmApplicationMetadataSchema.safeParse(
          client.metadata,
        ).data;
        return (
          metadata?.modelRouterProviderApiKeys.map(
            (mapping) => mapping.chatApiKeyId,
          ) ?? []
        );
      }),
    ),
  ];
  const apiKeyRows =
    chatApiKeyIds.length > 0
      ? await db
          .select({
            id: schema.llmProviderApiKeysTable.id,
            name: schema.llmProviderApiKeysTable.name,
          })
          .from(schema.llmProviderApiKeysTable)
          .where(inArray(schema.llmProviderApiKeysTable.id, chatApiKeyIds))
      : [];
  const apiKeyNames = new Map(apiKeyRows.map((row) => [row.id, row.name]));

  return clients.flatMap((client) => {
    const metadata = LlmApplicationMetadataSchema.safeParse(
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
        modelRouterProviderApiKeys: metadata.modelRouterProviderApiKeys.map(
          (mapping) => ({
            ...mapping,
            chatApiKeyName:
              apiKeyNames.get(mapping.chatApiKeyId) ?? mapping.chatApiKeyId,
          }),
        ),
        disabled: client.disabled ?? false,
        createdAt: client.createdAt,
        updatedAt: client.updatedAt,
      },
    ];
  });
}
