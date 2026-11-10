import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CreatedBy } from "@archestra/shared";
import {
  ALL_ARCHESTRA_TOKEN_PREFIXES,
  ARCHESTRA_TOKEN_PREFIX,
  MEMBER_ROLE_NAME,
  type Permissions,
  type ResourcePermissionGrant,
} from "@archestra/shared";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type {
  LabelWithDetails,
  SelectServiceAccount,
  SelectServiceAccountToken,
  ServiceAccountDetailResponse,
  ServiceAccountResponse,
  ServiceAccountTokenResponse,
} from "@/types";
import CreatedByModel, { lookupCreator } from "./created-by";
import { ServiceAccountLabelModel } from "./entity-labels";
import OrganizationRoleModel from "./organization-role";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import ResourcePermissionSubjectModel from "./resource-permission-subject";

/**
 * How often a token's `last_used_at` is rewritten while it is in use. The
 * column only feeds a "last used" label, so a minute of staleness is fine and
 * saves an UPDATE on every service-account request.
 */
const TOKEN_LAST_USED_REFRESH_MS = 60_000;

class ServiceAccountModel {
  static readonly MAX_TOKENS_PER_SERVICE_ACCOUNT = 50;

  static async listByOrganizationId(
    organizationId: string,
    labels?: Record<string, string[]>,
    /**
     * Restrict the page to the accounts this caller may read: a read grant on
     * the account, or at `*`. Omitted lists the organization's accounts
     * unfiltered, which is what the bulk handlers want: they load a batch and
     * then check each id on its own, so filtering here would report a refused
     * id as "not found" instead.
     */
    viewer?: { userId: string },
  ): Promise<ServiceAccountResponse[]> {
    const labelFilteredIds = labels
      ? await ServiceAccountLabelModel.getIdsMatchingLabels(labels)
      : null;
    if (labelFilteredIds?.length === 0) {
      return [];
    }

    const viewerPrincipal = viewer
      ? await ResourcePermissionSubjectModel.resolvePrincipal({
          organizationId,
          userId: viewer.userId,
        })
      : null;
    const now = new Date();
    const tokens = schema.serviceAccountTokensTable;
    const federated = schema.serviceAccountFederatedCredentialsTable;
    const rows = await db
      .select({
        serviceAccount: schema.serviceAccountsTable,
        tokenCount: count(tokens.id),
        // Same three conditions `findByToken` authenticates on, so the count
        // cannot disagree with what the gateway will actually accept. The
        // `id is not null` guard keeps the all-null row a LEFT JOIN produces
        // for a keyless account out of the tally.
        activeTokenCount:
          sql<number>`count(*) filter (where ${tokens.id} is not null and ${tokens.disabled} = false and (${tokens.expiresAt} is null or ${tokens.expiresAt} > ${now}))`.mapWith(
            Number,
          ),
        lastUsedAt: max(tokens.lastUsedAt),
        // `.mapWith` reuses the column's own decoder. Without it the driver
        // hands back a bare `timestamp without time zone` string that
        // `new Date(...)` reads as local time, shifting every expiry by the
        // server's UTC offset and disagreeing with the detail route.
        soonestExpiryAt:
          sql<Date | null>`min(${tokens.expiresAt}) filter (where ${tokens.disabled} = false and ${tokens.expiresAt} > ${now})`.mapWith(
            tokens.expiresAt,
          ),
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        federatedCredentialCount:
          sql<number>`(select count(*) from ${federated} where ${federated.serviceAccountId} = ${schema.serviceAccountsTable.id})`.mapWith(
            Number,
          ),
        federatedLastUsedAt:
          sql<Date | null>`(select max(${federated.lastUsedAt}) from ${federated} where ${federated.serviceAccountId} = ${schema.serviceAccountsTable.id})`.mapWith(
            federated.lastUsedAt,
          ),
        // SPDX-SnippetEnd
      })
      .from(schema.serviceAccountsTable)
      .leftJoin(
        tokens,
        and(
          eq(tokens.serviceAccountId, schema.serviceAccountsTable.id),
          // Tokens an OIDC exchange issued are not keys: they neither count
          // toward the account's keys nor decide its health.
          isNull(tokens.federatedCredentialId),
        ),
      )
      .where(
        and(
          eq(schema.serviceAccountsTable.organizationId, organizationId),
          ...(labelFilteredIds
            ? [inArray(schema.serviceAccountsTable.id, labelFilteredIds)]
            : []),
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          ...(viewerPrincipal
            ? [
                ResourcePermissionPolicyModel.grantCondition({
                  ...viewerPrincipal,
                  resource: "serviceAccount",
                  scopeColumn: schema.serviceAccountsTable.id,
                  action: "read",
                }),
              ]
            : []),
          // SPDX-SnippetEnd
        ),
      )
      .groupBy(schema.serviceAccountsTable.id)
      .orderBy(desc(schema.serviceAccountsTable.createdAt));

    const [labelsById, creators] = await Promise.all([
      ServiceAccountLabelModel.getLabelsForMany(
        rows.map(({ serviceAccount }) => serviceAccount.id),
      ),
      CreatedByModel.resolve(
        rows.map(({ serviceAccount }) =>
          CreatedByModel.id(serviceAccount, serviceAccount.createdBy),
        ),
      ),
    ]);

    return rows.map(
      ({
        serviceAccount,
        tokenCount,
        activeTokenCount,
        lastUsedAt,
        soonestExpiryAt,
        federatedCredentialCount,
        federatedLastUsedAt,
      }) =>
        normalizeServiceAccount(
          serviceAccount,
          {
            tokenCount,
            activeTokenCount,
            lastUsedAt: latest(
              lastUsedAt ? new Date(lastUsedAt) : null,
              federatedLastUsedAt ?? null,
            ),
            soonestExpiryAt: soonestExpiryAt ?? null,
            federatedCredentialCount,
          },
          creators,
          labelsById.get(serviceAccount.id) ?? [],
        ),
    );
  }

  static async findById(
    id: string,
    organizationId: string,
  ): Promise<ServiceAccountDetailResponse | null> {
    const [serviceAccount] = await db
      .select()
      .from(schema.serviceAccountsTable)
      .where(
        and(
          eq(schema.serviceAccountsTable.id, id),
          eq(schema.serviceAccountsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!serviceAccount) return null;

    const tokens = await db
      .select()
      .from(schema.serviceAccountTokensTable)
      .where(
        and(
          eq(schema.serviceAccountTokensTable.serviceAccountId, id),
          isNull(schema.serviceAccountTokensTable.federatedCredentialId),
        ),
      )
      .orderBy(desc(schema.serviceAccountTokensTable.createdAt));
    const tokenStats = summarizeTokens(tokens);
    const federated = await federatedStats(id);

    return {
      ...normalizeServiceAccount(
        serviceAccount,
        {
          ...tokenStats,
          lastUsedAt: latest(tokenStats.lastUsedAt, federated.lastUsedAt),
          federatedCredentialCount: federated.count,
        },
        await CreatedByModel.resolve([
          CreatedByModel.id(serviceAccount, serviceAccount.createdBy),
        ]),
        await ServiceAccountLabelModel.getLabelsFor(id),
      ),
      tokens: tokens.map(normalizeToken),
    };
  }

  /**
   * Display names for a batch of service-account ids, scoped to one
   * organization. Ids with no row (deleted account, or an id belonging to a
   * different organization) are simply absent from the map.
   */
  static async getNamesByIds(
    ids: string[],
    organizationId: string,
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({
        id: schema.serviceAccountsTable.id,
        name: schema.serviceAccountsTable.name,
      })
      .from(schema.serviceAccountsTable)
      .where(
        and(
          inArray(schema.serviceAccountsTable.id, ids),
          eq(schema.serviceAccountsTable.organizationId, organizationId),
        ),
      );
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const serviceAccount = await ServiceAccountModel.findById(
      id,
      organizationId,
    );
    if (!serviceAccount) return null;

    return {
      id: serviceAccount.id,
      organizationId: serviceAccount.organizationId,
      name: serviceAccount.name,
      icon: serviceAccount.icon,
      role: serviceAccount.role,
      teamId: serviceAccount.teamId,
      disabled: serviceAccount.disabled,
      tokenCount: serviceAccount.tokenCount,
      createdAt: serviceAccount.createdAt.toISOString(),
      updatedAt: serviceAccount.updatedAt.toISOString(),
    };
  }

  static async create(params: {
    organizationId: string;
    name: string;
    icon?: string | null;
    role: string;
    teamId?: string | null;
    labels?: LabelWithDetails[];
    /**
     * Required, but nullable: every interactive create knows its user, and
     * making the parameter mandatory stops a new call path from silently
     * dropping the creator. Non-interactive callers (seeding, tests) say `null`
     * rather than being allowed to forget.
     */
    createdBy: string | null;
    /** Explicit starting audience; omitted starts the account with its creator. */
    initialPermissionGrants?: ResourcePermissionGrant[];
  }): Promise<ServiceAccountDetailResponse> {
    // The access policy is written with the row it governs, so a failure
    // cannot leave an account nobody can manage.
    const serviceAccount = await withDbTransaction(async (tx) => {
      const [created] = await tx
        .insert(schema.serviceAccountsTable)
        .values(
          await CreatedByModel.forInsert({
            data: {
              organizationId: params.organizationId,
              name: params.name,
              icon: params.icon,
              role: params.role,
              teamId: params.teamId ?? null,
              createdBy: params.createdBy,
            },
            userIdField: "createdBy",
            transaction: tx,
          }),
        )
        .returning();
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissionPolicyModel.createInitial({
        tx,
        organizationId: created.organizationId,
        resource: "serviceAccount",
        scope: created.id,
        grants: params.initialPermissionGrants,
        authorId: CreatedByModel.id(created, created.createdBy) ?? null,
        // No `visibility`: an account has no audience to derive one from. The
        // roles that reach every account hold their grant at `*` already, so
        // deriving here would only copy those same rows onto each object,
        // where deleting one would not revoke anything.
      });
      // SPDX-SnippetEnd
      return created;
    });

    if (params.labels?.length) {
      await ServiceAccountLabelModel.syncLabels(
        serviceAccount.id,
        params.labels,
      );
    }

    return {
      ...normalizeServiceAccount(
        serviceAccount,
        { ...summarizeTokens([]), federatedCredentialCount: 0 },
        await CreatedByModel.resolve([
          CreatedByModel.id(serviceAccount, serviceAccount.createdBy),
        ]),
        await ServiceAccountLabelModel.getLabelsFor(serviceAccount.id),
      ),
      tokens: [],
    };
  }

  static async update(
    id: string,
    organizationId: string,
    data: Partial<
      Pick<
        SelectServiceAccount,
        "name" | "icon" | "role" | "disabled" | "teamId"
      >
    > & {
      labels?: LabelWithDetails[];
    },
  ): Promise<ServiceAccountDetailResponse | null> {
    const { labels, ...columns } = data;
    const [serviceAccount] = await db
      .update(schema.serviceAccountsTable)
      // An update with only labels must still resolve the row, so the SET is
      // given the row's own id rather than being empty.
      .set(
        Object.keys(columns).length > 0
          ? columns
          : { id: schema.serviceAccountsTable.id },
      )
      .where(
        and(
          eq(schema.serviceAccountsTable.id, id),
          eq(schema.serviceAccountsTable.organizationId, organizationId),
        ),
      )
      .returning();

    if (!serviceAccount) return null;

    // Only touch labels when the caller explicitly sent them, so an update that
    // omits the field leaves existing labels alone.
    if (labels !== undefined) {
      await ServiceAccountLabelModel.syncLabels(serviceAccount.id, labels);
    }

    return ServiceAccountModel.findById(serviceAccount.id, organizationId);
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    return await withDbTransaction(async (tx) => {
      const deleted = await tx
        .delete(schema.serviceAccountsTable)
        .where(
          and(
            eq(schema.serviceAccountsTable.id, id),
            eq(schema.serviceAccountsTable.organizationId, organizationId),
          ),
        )
        .returning({ id: schema.serviceAccountsTable.id });
      if (deleted.length === 0) return false;
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // The id is gone for good, so leaving its policy behind would hand the
      // grants to whatever row reused the id.
      await ResourcePermissionPolicyModel.deleteForTarget({
        tx,
        resources: ["serviceAccount"],
        scope: id,
      });
      // SPDX-SnippetEnd
      return true;
    });
  }

  static async createToken(params: {
    serviceAccountId: string;
    organizationId: string;
    name: string;
    expiresIn?: number | null;
  }): Promise<ServiceAccountTokenResponse & { token: string }> {
    const serviceAccount = await ServiceAccountModel.findById(
      params.serviceAccountId,
      params.organizationId,
    );
    if (!serviceAccount) {
      throw new Error("Service account not found");
    }
    if (
      serviceAccount.tokenCount >=
      ServiceAccountModel.MAX_TOKENS_PER_SERVICE_ACCOUNT
    ) {
      throw new Error("Service account token limit exceeded");
    }

    const token = createTokenValue();
    const expiresAt = params.expiresIn
      ? new Date(Date.now() + params.expiresIn * 1000)
      : null;
    const [created] = await db
      .insert(schema.serviceAccountTokensTable)
      .values({
        serviceAccountId: params.serviceAccountId,
        name: params.name,
        tokenHash: hashToken(token),
        tokenStart: token.slice(0, 16),
        expiresAt,
      })
      .returning();

    return { ...normalizeToken(created), token };
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * The account an OIDC token exchange names. The exchange is public, so it
   * learns the organization from the account, not from a session.
   */
  static async findForTokenExchange(
    id: string,
  ): Promise<Pick<
    SelectServiceAccount,
    "id" | "name" | "organizationId" | "disabled"
  > | null> {
    const [row] = await db
      .select({
        id: schema.serviceAccountsTable.id,
        name: schema.serviceAccountsTable.name,
        organizationId: schema.serviceAccountsTable.organizationId,
        disabled: schema.serviceAccountsTable.disabled,
      })
      .from(schema.serviceAccountsTable)
      .where(eq(schema.serviceAccountsTable.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * A short-lived token for an OIDC token exchange through one federated
   * credential. It authenticates exactly like an API key of the account, so it
   * carries the account's roles and stops working when the account is
   * disabled. Expired tokens of the same credential are removed first, so the
   * rows a busy CI pipeline leaves behind stay bounded.
   */
  static async createFederatedToken(params: {
    serviceAccountId: string;
    federatedCredentialId: string;
    name: string;
    expiresAt: Date;
  }): Promise<{ token: string; expiresAt: Date }> {
    const token = createTokenValue();
    await withDbTransaction(async (tx) => {
      await tx
        .delete(schema.serviceAccountTokensTable)
        .where(
          and(
            eq(
              schema.serviceAccountTokensTable.federatedCredentialId,
              params.federatedCredentialId,
            ),
            lte(schema.serviceAccountTokensTable.expiresAt, new Date()),
          ),
        );
      await tx.insert(schema.serviceAccountTokensTable).values({
        serviceAccountId: params.serviceAccountId,
        federatedCredentialId: params.federatedCredentialId,
        name: params.name,
        tokenHash: hashToken(token),
        tokenStart: token.slice(0, 16),
        expiresAt: params.expiresAt,
      });
    });
    return { token, expiresAt: params.expiresAt };
  }
  // SPDX-SnippetEnd

  static async deleteToken(params: {
    serviceAccountId: string;
    tokenId: string;
    organizationId: string;
  }): Promise<boolean> {
    const serviceAccount = await ServiceAccountModel.findById(
      params.serviceAccountId,
      params.organizationId,
    );
    if (!serviceAccount) return false;

    const deleted = await db
      .delete(schema.serviceAccountTokensTable)
      .where(
        and(
          eq(schema.serviceAccountTokensTable.id, params.tokenId),
          eq(
            schema.serviceAccountTokensTable.serviceAccountId,
            params.serviceAccountId,
          ),
        ),
      )
      .returning({ id: schema.serviceAccountTokensTable.id });

    return deleted.length > 0;
  }

  static async updateToken(params: {
    serviceAccountId: string;
    tokenId: string;
    organizationId: string;
    data: Partial<
      Pick<SelectServiceAccountToken, "name" | "expiresAt" | "disabled">
    >;
  }): Promise<ServiceAccountTokenResponse | null> {
    const serviceAccount = await ServiceAccountModel.findById(
      params.serviceAccountId,
      params.organizationId,
    );
    if (!serviceAccount) return null;

    const [updated] = await db
      .update(schema.serviceAccountTokensTable)
      .set(params.data)
      .where(
        and(
          eq(schema.serviceAccountTokensTable.id, params.tokenId),
          eq(
            schema.serviceAccountTokensTable.serviceAccountId,
            params.serviceAccountId,
          ),
        ),
      )
      .returning();

    return updated ? normalizeToken(updated) : null;
  }

  /** The account row alone, without the keys {@link findById} lists. */
  static async findAccount(
    id: string,
    organizationId: string,
  ): Promise<SelectServiceAccount | null> {
    const [row] = await db
      .select()
      .from(schema.serviceAccountsTable)
      .where(
        and(
          eq(schema.serviceAccountsTable.id, id),
          eq(schema.serviceAccountsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Adopt an existing token value as one of the account's keys, so a client
   * already configured with it keeps working. Returns false when that value
   * already belongs to a service account, which makes re-running an import a
   * no-op.
   */
  static async importToken(params: {
    serviceAccountId: string;
    name: string;
    value: string;
    lastUsedAt: Date | null;
    createdAt: Date;
  }): Promise<boolean> {
    const inserted = await db
      .insert(schema.serviceAccountTokensTable)
      .values({
        serviceAccountId: params.serviceAccountId,
        name: params.name,
        tokenHash: hashToken(params.value),
        tokenStart: params.value.slice(0, 16),
        lastUsedAt: params.lastUsedAt,
        createdAt: params.createdAt,
      })
      .onConflictDoNothing()
      .returning({ id: schema.serviceAccountTokensTable.id });
    return inserted.length > 0;
  }

  static async isNameTaken(
    organizationId: string,
    name: string,
  ): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.serviceAccountsTable.id })
      .from(schema.serviceAccountsTable)
      .where(
        and(
          eq(schema.serviceAccountsTable.organizationId, organizationId),
          eq(schema.serviceAccountsTable.name, name),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  static async isTokenImported(value: string): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.serviceAccountTokensTable.id })
      .from(schema.serviceAccountTokensTable)
      .where(eq(schema.serviceAccountTokensTable.tokenHash, hashToken(value)))
      .limit(1);
    return Boolean(row);
  }

  static async verifyToken(token: string): Promise<{
    serviceAccount: SelectServiceAccount;
    token: SelectServiceAccountToken;
  } | null> {
    // Imported team and organization tokens keep their original value, which
    // may carry a legacy prefix.
    if (
      !ALL_ARCHESTRA_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix))
    )
      return null;

    const tokenHash = hashToken(token);
    const [row] = await db
      .select({
        serviceAccount: getTableColumns(schema.serviceAccountsTable),
        token: getTableColumns(schema.serviceAccountTokensTable),
      })
      .from(schema.serviceAccountTokensTable)
      .innerJoin(
        schema.serviceAccountsTable,
        eq(
          schema.serviceAccountsTable.id,
          schema.serviceAccountTokensTable.serviceAccountId,
        ),
      )
      .where(
        and(
          eq(schema.serviceAccountTokensTable.tokenHash, tokenHash),
          eq(schema.serviceAccountsTable.disabled, false),
          eq(schema.serviceAccountTokensTable.disabled, false),
          or(
            isNull(schema.serviceAccountTokensTable.expiresAt),
            gt(schema.serviceAccountTokensTable.expiresAt, new Date()),
          ),
        ),
      )
      .limit(1);

    if (!row || !isTokenHashEqual(row.token.tokenHash, tokenHash)) {
      return null;
    }

    // last_used_at feeds a "last used" label; writing it on every request put
    // an UPDATE on the hot path of every service-account call. Refresh it at
    // most once per TOKEN_LAST_USED_REFRESH_MS per token.
    const lastUsedAt = row.token.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - lastUsedAt >= TOKEN_LAST_USED_REFRESH_MS) {
      await db
        .update(schema.serviceAccountTokensTable)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.serviceAccountTokensTable.id, row.token.id));
    }

    return row;
  }

  /**
   * The columns the authorization path needs for a synthetic service-account
   * caller. `findById` also reads the tokens, the creator and the labels:
   * four statements per permission check, paid on every request.
   */
  static async findAuthContext(
    id: string,
    organizationId: string,
  ): Promise<Pick<
    SelectServiceAccount,
    "organizationId" | "role" | "disabled"
  > | null> {
    const [row] = await db
      .select({
        organizationId: schema.serviceAccountsTable.organizationId,
        role: schema.serviceAccountsTable.role,
        disabled: schema.serviceAccountsTable.disabled,
      })
      .from(schema.serviceAccountsTable)
      .where(
        and(
          eq(schema.serviceAccountsTable.id, id),
          eq(schema.serviceAccountsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async getPermissions(
    serviceAccount: Pick<SelectServiceAccount, "organizationId" | "role">,
  ): Promise<Permissions> {
    return OrganizationRoleModel.getPermissions(
      serviceAccount.role || MEMBER_ROLE_NAME,
      serviceAccount.organizationId,
    );
  }
}

export default ServiceAccountModel;

// === Internal helpers

function normalizeServiceAccount(
  serviceAccount: SelectServiceAccount,
  stats: TokenStats & { federatedCredentialCount: number },
  creators: Map<string, CreatedBy>,
  labels: LabelWithDetails[] = [],
): ServiceAccountResponse {
  return {
    createdBy: lookupCreator(
      creators,
      CreatedByModel.id(serviceAccount, serviceAccount.createdBy),
    ),
    labels,
    id: serviceAccount.id,
    organizationId: serviceAccount.organizationId,
    name: serviceAccount.name,
    icon: serviceAccount.icon,
    role: serviceAccount.role,
    teamId: serviceAccount.teamId,
    disabled: serviceAccount.disabled,
    createdAt: serviceAccount.createdAt,
    updatedAt: serviceAccount.updatedAt,
    tokenCount: stats.tokenCount,
    activeTokenCount: stats.activeTokenCount,
    lastUsedAt: stats.lastUsedAt,
    soonestExpiryAt: stats.soonestExpiryAt,
    federatedCredentialCount: stats.federatedCredentialCount,
  };
}

type TokenStats = {
  tokenCount: number;
  activeTokenCount: number;
  lastUsedAt: Date | null;
  soonestExpiryAt: Date | null;
};

/**
 * Token stats for a call site that already holds the rows, so it does not pay
 * for the aggregate `listByOrganizationId` runs in SQL. Kept beside that query
 * on purpose: both must agree with `findByToken`'s authentication conditions.
 */
function summarizeTokens(
  tokens: SelectServiceAccountToken[],
  now = new Date(),
): TokenStats {
  let activeTokenCount = 0;
  let lastUsedAt: Date | null = null;
  let soonestExpiryAt: Date | null = null;
  for (const token of tokens) {
    if (!token.disabled && (!token.expiresAt || token.expiresAt > now)) {
      activeTokenCount++;
    }
    if (token.lastUsedAt && (!lastUsedAt || token.lastUsedAt > lastUsedAt)) {
      lastUsedAt = token.lastUsedAt;
    }
    if (
      !token.disabled &&
      token.expiresAt &&
      token.expiresAt > now &&
      (!soonestExpiryAt || token.expiresAt < soonestExpiryAt)
    ) {
      soonestExpiryAt = token.expiresAt;
    }
  }
  return {
    tokenCount: tokens.length,
    activeTokenCount,
    lastUsedAt,
    soonestExpiryAt,
  };
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
async function federatedStats(
  serviceAccountId: string,
): Promise<{ count: number; lastUsedAt: Date | null }> {
  const federated = schema.serviceAccountFederatedCredentialsTable;
  const [row] = await db
    .select({
      count: count(federated.id),
      lastUsedAt: max(federated.lastUsedAt),
    })
    .from(federated)
    .where(eq(federated.serviceAccountId, serviceAccountId));
  return {
    count: row?.count ?? 0,
    lastUsedAt: row?.lastUsedAt ? new Date(row.lastUsedAt) : null,
  };
}
// SPDX-SnippetEnd

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function normalizeToken(
  token: SelectServiceAccountToken,
): ServiceAccountTokenResponse {
  return {
    id: token.id,
    name: token.name,
    tokenStart: token.tokenStart,
    disabled: token.disabled,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
  };
}

function createTokenValue(): string {
  return `${ARCHESTRA_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function hashToken(token: string): string {
  // codeql[js/insufficient-password-hash] Lookup digest of a randomBytes(32) bearer token, not a password. OAuth issuer return values are heuristically classified as passwords.
  return createHash("sha256").update(token).digest("hex");
}

function isTokenHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
