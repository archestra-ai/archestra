import { randomBytes } from "node:crypto";
import {
  LLM_PROXY_OAUTH_SCOPE,
  OFFLINE_ACCESS_OAUTH_SCOPE,
  type PaginationQuery,
  type ResourcePermissionGrant,
} from "@archestra/shared";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, count, eq, ilike, inArray, sql } from "drizzle-orm";
import { hashOauthClientSecret } from "@/auth/oauth-client-secret";
import db, { schema, withDbTransaction } from "@/database";
import { createPaginatedResult } from "@/database/utils/pagination";
import {
  LLM_OAUTH_CLIENT_METADATA_TYPE,
  type LlmOauthClientGrantType,
  LlmOauthClientMetadataSchema,
  type LlmOauthClientProviderKey,
} from "@/types/llm-oauth-client";
import { escapeLikePattern } from "@/utils/sql-search";
import CreatedByModel, { lookupCreator } from "./created-by";
import { OauthClientLabelModel } from "./entity-labels";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import UserModel from "./user";

class LlmOauthClientModel {
  static async findAllByOrganization(params: {
    organizationId: string;
    search?: string;
    providerApiKeyId?: string;
    /**
     * Restricts results to clients the user holds `read` on, directly or
     * through a team, role or `*` grant. Omit only for internal callers that
     * must see everything (e.g. the provider-API-key delete guard).
     */
    viewer?: { userId: string };
  }) {
    const rows = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(listWhereClause(params))
      .orderBy(schema.oauthClientsTable.createdAt);

    return hydrateOauthClients(rows);
  }

  /**
   * Paginated listing for the management table. Internal callers that must
   * see every client (e.g. the provider-API-key delete guard) use
   * {@link LlmOauthClientModel.findAllByOrganization} instead.
   */
  static async findPageByOrganization(params: {
    organizationId: string;
    pagination: PaginationQuery;
    search?: string;
    providerApiKeyId?: string;
    grantType?: LlmOauthClientGrantType;
    labels?: Record<string, string[]>;
    viewer?: { userId: string };
  }) {
    const labelFilteredIds = params.labels
      ? await OauthClientLabelModel.getIdsMatchingLabels(params.labels)
      : undefined;
    const whereClause = listWhereClause({ ...params, labelFilteredIds });
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.oauthClientsTable)
        .where(whereClause)
        .orderBy(schema.oauthClientsTable.createdAt)
        .limit(params.pagination.limit)
        .offset(params.pagination.offset),
      db
        .select({ total: count() })
        .from(schema.oauthClientsTable)
        .where(whereClause),
    ]);

    return createPaginatedResult(
      await hydrateOauthClients(rows),
      Number(total),
      params.pagination,
    );
  }

  /**
   * Load the named clients within one organization for a bulk operation. Ids
   * outside the organization are simply absent, indistinguishable from ids
   * that never existed.
   */
  static async findByIds(params: {
    ids: string[];
    organizationId: string;
    /**
     * Fences the result to clients the user holds `read` on — required for
     * caller-supplied id
     * lists, where an unfenced load would let an opaque id confirm and name
     * a hidden credential. Omit only for internal callers (audit snapshots).
     */
    viewer?: { userId: string };
  }) {
    if (params.ids.length === 0) return [];

    const rows = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(
        and(
          inArray(schema.oauthClientsTable.id, params.ids),
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
          sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          params.viewer
            ? ResourcePermissionPolicyModel.grantCondition({
                organizationId: params.organizationId,
                userId: params.viewer.userId,
                resource: "llmOauthClient",
                scopeColumn: schema.oauthClientsTable.id,
                action: "read",
              })
            : undefined,
          // SPDX-SnippetEnd
        ),
      );

    return hydrateOauthClients(rows);
  }

  static async create(params: {
    organizationId: string;
    name: string;
    grantType?: LlmOauthClientGrantType;
    providerApiKeys?: LlmOauthClientProviderKey[];
    redirectUris?: string[];
    authorId: string;
    /** The starting audience beside the author, who always gets full access. */
    initialGrants?: ResourcePermissionGrant[];
  }) {
    const grantType = params.grantType ?? "client_credentials";
    const isAuthorizationCode = grantType === "authorization_code";
    const clientSecret = createClientSecret();
    // authorization_code secrets are verified by better-auth (deterministic
    // hash); client_credentials secrets are verified by this model (bcrypt).
    const clientSecretHash = isAuthorizationCode
      ? hashOauthClientSecret(clientSecret)
      : await hashClientSecret(clientSecret);
    // providerApiKeys never apply to authorization_code clients: the acting
    // user's own keys are resolved at call time.
    const metadata = {
      type: LLM_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: params.organizationId,
      grantType,
      providerApiKeys: isAuthorizationCode
        ? []
        : (params.providerApiKeys ?? []),
      authorId: params.authorId,
    };

    const client = await withDbTransaction(async (tx) => {
      const [row] = await tx
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

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // Written with the row it governs, so a failure cannot leave a client
      // nobody can manage.
      await ResourcePermissionPolicyModel.createInitial({
        tx,
        organizationId: params.organizationId,
        resource: "llmOauthClient",
        scope: row.id,
        grants: params.initialGrants ?? [],
        authorId: params.authorId,
      });
      // SPDX-SnippetEnd
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
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
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
          sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
        ),
      )
      .limit(1);

    return client ? ((await hydrateOauthClients([client]))[0] ?? null) : null;
  }

  static async findByProviderApiKeyId(params: {
    providerApiKeyId: string;
    organizationId: string;
  }) {
    // Deliberately unfiltered (no viewer): the provider-API-key delete guard
    // must see every client that still maps to the key — including clients
    // the acting user holds no grant on — or a
    // deletion would silently break those clients' runtime routing.
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

    // providerApiKeys never apply to authorization_code clients.
    // The author is fixed at creation; scope falls back to the existing value.
    const metadata = {
      type: LLM_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: params.organizationId,
      grantType: existing.grantType,
      providerApiKeys: isAuthorizationCode
        ? []
        : (params.providerApiKeys ??
          existing.providerApiKeys.map((key) => ({
            provider: key.provider,
            providerApiKeyId: key.providerApiKeyId,
          }))),
      authorId: existing.authorId,
    };

    const client = await withDbTransaction(async (tx) => {
      const [row] = await tx
        .update(schema.oauthClientsTable)
        .set({
          name: params.name,
          // Merged, so keys this model no longer writes (the retired `scope`)
          // stay on the row as history rather than vanishing on first edit.
          metadata: sql`${schema.oauthClientsTable.metadata} || ${JSON.stringify(metadata)}::jsonb`,
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
      return row;
    });

    return client ? ((await hydrateOauthClients([client]))[0] ?? null) : null;
  }

  static async delete(params: { id: string; organizationId: string }) {
    return withDbTransaction(async (tx) => {
      const result = await tx
        .delete(schema.oauthClientsTable)
        .where(
          and(
            eq(schema.oauthClientsTable.id, params.id),
            sql`${schema.oauthClientsTable.metadata}->>'type' = ${LLM_OAUTH_CLIENT_METADATA_TYPE}`,
            sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
          ),
        )
        .returning({ id: schema.oauthClientsTable.id });
      if (result.length === 0) return false;
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // The id is gone for good; a policy left behind would hand its grants
      // to whatever row reused the id.
      await ResourcePermissionPolicyModel.deleteForTarget({
        tx,
        resources: ["llmOauthClient"],
        scope: params.id,
      });
      // SPDX-SnippetEnd
      return true;
    });
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
      authorId: client.authorId,
      createdAt: client.createdAt.toISOString(),
      updatedAt: client.updatedAt.toISOString(),
    };
  }
}

export default LlmOauthClientModel;

/**
 * Where-clause shared by the list queries: fences to LLM OAuth clients of one
 * organization and applies the optional search / provider-key / grant-type /
 * viewer-visibility filters.
 */
function listWhereClause(params: {
  organizationId: string;
  search?: string;
  providerApiKeyId?: string;
  grantType?: LlmOauthClientGrantType;
  viewer?: { userId: string };
  /** Client ids matching a `?labels=` filter; omit when not filtering. */
  labelFilteredIds?: string[];
}) {
  return and(
    params.labelFilteredIds !== undefined
      ? inArray(schema.oauthClientsTable.id, params.labelFilteredIds)
      : undefined,
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
    // Rows created before authorization_code support carry no grantType and
    // behave as client_credentials everywhere, so the filter treats them so.
    params.grantType
      ? sql`COALESCE(${schema.oauthClientsTable.metadata}->>'grantType', 'client_credentials') = ${params.grantType}`
      : undefined,
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    params.viewer
      ? ResourcePermissionPolicyModel.grantCondition({
          organizationId: params.organizationId,
          userId: params.viewer.userId,
          resource: "llmOauthClient",
          scopeColumn: schema.oauthClientsTable.id,
          action: "read",
        })
      : undefined,
    // SPDX-SnippetEnd
  );
}

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
  const parsed = clients.map((client) => ({
    client,
    metadata: LlmOauthClientMetadataSchema.safeParse(client.metadata).data,
  }));

  const providerApiKeyIds = [
    ...new Set(
      parsed.flatMap(({ metadata }) =>
        metadata
          ? metadata.providerApiKeys.map((mapping) => mapping.providerApiKeyId)
          : [],
      ),
    ),
  ];
  const authorIds = [
    ...new Set(
      parsed.flatMap(({ metadata }) =>
        metadata?.authorId ? [metadata.authorId] : [],
      ),
    ),
  ];
  const [apiKeyRows, authorNames, creators, labelsByClient] = await Promise.all(
    [
      providerApiKeyIds.length > 0
        ? db
            .select({
              id: schema.llmProviderApiKeysTable.id,
              name: schema.llmProviderApiKeysTable.name,
              provider: schema.llmProviderApiKeysTable.provider,
            })
            .from(schema.llmProviderApiKeysTable)
            .where(
              inArray(schema.llmProviderApiKeysTable.id, providerApiKeyIds),
            )
        : [],
      UserModel.getNamesByIds(authorIds),
      CreatedByModel.resolve(authorIds),
      OauthClientLabelModel.getLabelsForMany(clients.map((c) => c.id)),
    ],
  );
  const apiKeyNames = new Map(apiKeyRows.map((row) => [row.id, row.name]));

  return parsed.flatMap(({ client, metadata }) => {
    if (!metadata) return [];
    return [
      {
        id: client.id,
        clientId: client.clientId,
        name: client.name ?? client.clientId,
        organizationId: metadata.organizationId,
        grantType: metadata.grantType,
        providerApiKeys: metadata.providerApiKeys.map((mapping) => ({
          ...mapping,
          providerApiKeyName:
            apiKeyNames.get(mapping.providerApiKeyId) ??
            mapping.providerApiKeyId,
        })),
        redirectUris: client.redirectUris ?? [],
        disabled: client.disabled ?? false,
        authorId: metadata.authorId,
        authorName: metadata.authorId
          ? (authorNames.get(metadata.authorId) ?? null)
          : null,
        createdBy: lookupCreator(
          creators,
          CreatedByModel.id(metadata, metadata.authorId),
        ),
        labels: labelsByClient.get(client.id) ?? [],
        createdAt: client.createdAt,
        updatedAt: client.updatedAt,
      },
    ];
  });
}
