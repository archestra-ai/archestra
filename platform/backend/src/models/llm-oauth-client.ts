import { randomBytes } from "node:crypto";
import {
  LLM_PROXY_OAUTH_SCOPE,
  OFFLINE_ACCESS_OAUTH_SCOPE,
} from "@archestra/shared";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { hashOauthClientSecret } from "@/auth/oauth-client-secret";
import db, { schema } from "@/database";
import {
  LLM_OAUTH_CLIENT_METADATA_TYPE,
  type LlmOauthClientGrantType,
  LlmOauthClientMetadataSchema,
  type LlmOauthClientProviderKey,
} from "@/types/llm-oauth-client";
import { escapeLikePattern } from "@/utils/sql-search";

class LlmOauthClientModel {
  static async findAllByOrganization(params: {
    organizationId: string;
    search?: string;
    providerApiKeyId?: string;
  }) {
    const rows = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(
        and(
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
          params.search
            ? ilike(
                schema.oauthClientsTable.name,
                `%${escapeLikePattern(params.search.trim())}%`,
              )
            : undefined,
          params.providerApiKeyId
            ? sql`${schema.oauthClientsTable.metadata}->'providerApiKeys' @> ${JSON.stringify([{ providerApiKeyId: params.providerApiKeyId }])}::jsonb`
            : undefined,
        ),
      )
      .orderBy(schema.oauthClientsTable.createdAt);

    return hydrateOauthClients(rows);
  }

  static async create(params: {
    organizationId: string;
    name: string;
    grantType?: LlmOauthClientGrantType;
    allowedLlmProxyIds?: string[];
    providerApiKeys?: LlmOauthClientProviderKey[];
    redirectUris?: string[];
  }) {
    const grantType = params.grantType ?? "client_credentials";
    const isAuthorizationCode = grantType === "authorization_code";
    const clientSecret = createClientSecret();
    // authorization_code secrets are verified by better-auth (deterministic
    // hash); client_credentials secrets are verified by this model (bcrypt).
    const clientSecretHash = isAuthorizationCode
      ? hashOauthClientSecret(clientSecret)
      : await hashClientSecret(clientSecret);
    // allowedLlmProxyIds governs both grant types, but differently:
    // - client_credentials: the SOLE authority — the token may only reach the
    //   listed proxies (there is no acting user).
    // - authorization_code: an ADDITIVE, admin-controlled grant — a user who
    //   authenticates through the client may reach these proxies IN ADDITION to
    //   their own RBAC. Empty = pure identity passthrough.
    // providerApiKeys never apply to authorization_code clients: the acting
    // user's own keys are resolved at call time.
    const metadata = {
      type: LLM_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: params.organizationId,
      grantType,
      allowedLlmProxyIds: params.allowedLlmProxyIds ?? [],
      providerApiKeys: isAuthorizationCode
        ? []
        : (params.providerApiKeys ?? []),
    };

    const [client] = await db
      .insert(schema.oauthClientsTable)
      .values({
        id: crypto.randomUUID(),
        clientId: `llm_oauth_${randomBytes(18).toString("base64url")}`,
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
          ? [LLM_PROXY_OAUTH_SCOPE, OFFLINE_ACCESS_OAUTH_SCOPE]
          : [LLM_PROXY_OAUTH_SCOPE],
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
    return LlmOauthClientModel.findAllByOrganization({
      organizationId: params.organizationId,
      providerApiKeyId: params.providerApiKeyId,
    });
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
    // Hash the new secret with the scheme this client's grant type uses.
    const existing = await LlmOauthClientModel.findById(params);
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
    allowedLlmProxyIds?: string[];
    providerApiKeys?: LlmOauthClientProviderKey[];
    redirectUris?: string[];
  }) {
    // The grant type is fixed at creation; reload the client to preserve it and
    // to apply only the fields that grant type actually uses.
    const existing = await LlmOauthClientModel.findById({
      id: params.id,
      organizationId: params.organizationId,
    });
    if (!existing) return null;
    const isAuthorizationCode = existing.grantType === "authorization_code";

    // allowedLlmProxyIds applies to both grant types (see create()); update it
    // for either. providerApiKeys never apply to authorization_code clients.
    const metadata = {
      type: LLM_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: params.organizationId,
      grantType: existing.grantType,
      allowedLlmProxyIds:
        params.allowedLlmProxyIds ?? existing.allowedLlmProxyIds,
      providerApiKeys: isAuthorizationCode
        ? []
        : (params.providerApiKeys ??
          existing.providerApiKeys.map((key) => ({
            provider: key.provider,
            providerApiKeyId: key.providerApiKeyId,
          }))),
    };

    const [client] = await db
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

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const client = await LlmOauthClientModel.findById({ id, organizationId });
    if (!client) return null;

    return {
      id: client.id,
      name: client.name,
      clientId: client.clientId,
      organizationId: client.organizationId,
      grantType: client.grantType,
      allowedLlmProxyIds: [...client.allowedLlmProxyIds].sort(),
      // Sort by providerApiKeyId so audit diffs ignore source ordering and
      // only flag genuine add/remove changes.
      providerApiKeys: [...client.providerApiKeys]
        .sort((a, b) => a.providerApiKeyId.localeCompare(b.providerApiKeyId))
        .map((p) => ({
          provider: p.provider,
          providerApiKeyId: p.providerApiKeyId,
          providerApiKeyName: p.providerApiKeyName,
        })),
      redirectUris: [...client.redirectUris].sort(),
      disabled: client.disabled,
      createdAt: client.createdAt.toISOString(),
      updatedAt: client.updatedAt.toISOString(),
    };
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
        grantType: metadata.grantType,
        allowedLlmProxyIds: metadata.allowedLlmProxyIds,
        providerApiKeys: metadata.providerApiKeys.map((mapping) => ({
          ...mapping,
          providerApiKeyName:
            apiKeyNames.get(mapping.providerApiKeyId) ??
            mapping.providerApiKeyId,
        })),
        redirectUris: client.redirectUris ?? [],
        disabled: client.disabled ?? false,
        createdAt: client.createdAt,
        updatedAt: client.updatedAt,
      },
    ];
  });
}
