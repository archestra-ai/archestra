import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CreatedBy } from "@archestra/shared";
import {
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
  isNotNull,
  isNull,
  lt,
  max,
  or,
  sql,
} from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import { secretManager } from "@/secrets-manager";
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
      })
      .from(schema.serviceAccountsTable)
      .leftJoin(
        tokens,
        and(
          eq(tokens.serviceAccountId, schema.serviceAccountsTable.id),
          isNull(tokens.secretId),
        ),
      )
      .where(
        and(
          eq(schema.serviceAccountsTable.organizationId, organizationId),
          eq(schema.serviceAccountsTable.isSystem, false),
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
      }) =>
        normalizeServiceAccount(
          serviceAccount,
          {
            tokenCount,
            activeTokenCount,
            lastUsedAt: lastUsedAt ? new Date(lastUsedAt) : null,
            soonestExpiryAt: soonestExpiryAt ?? null,
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
          eq(schema.serviceAccountsTable.isSystem, false),
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
          isNull(schema.serviceAccountTokensTable.secretId),
        ),
      )
      .orderBy(desc(schema.serviceAccountTokensTable.createdAt));

    return {
      ...normalizeServiceAccount(
        serviceAccount,
        summarizeTokens(tokens),
        await CreatedByModel.resolve([
          CreatedByModel.id(serviceAccount, serviceAccount.createdBy),
        ]),
        await ServiceAccountLabelModel.getLabelsFor(id),
      ),
      tokens: tokens.map(normalizeToken),
    };
  }

  /**
   * The account row as the platform sees it, built-in system account
   * included. For acting as an account, not for showing one: routes use
   * {@link findById}, which hides the system account.
   */
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
        summarizeTokens([]),
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
      Pick<SelectServiceAccount, "name" | "role" | "disabled" | "teamId">
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
          eq(schema.serviceAccountsTable.isSystem, false),
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
            eq(schema.serviceAccountsTable.isSystem, false),
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
          isNull(schema.serviceAccountTokensTable.secretId),
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
          isNull(schema.serviceAccountTokensTable.secretId),
        ),
      )
      .returning();

    return updated ? normalizeToken(updated) : null;
  }

  /**
   * The organization's built-in account for work with no user behind it,
   * created on first use. Concurrent first calls converge on one row through
   * the partial unique index.
   */
  static async ensureSystemServiceAccount(
    organizationId: string,
  ): Promise<SelectServiceAccount> {
    const existing = await findSystemServiceAccount(organizationId);
    if (existing) return existing;

    await db
      .insert(schema.serviceAccountsTable)
      .values({
        organizationId,
        name: SYSTEM_SERVICE_ACCOUNT_NAME,
        role: MEMBER_ROLE_NAME,
        isSystem: true,
        createdBy: null,
      })
      .onConflictDoNothing();

    const created = await findSystemServiceAccount(organizationId);
    if (!created) {
      throw new Error("Failed to create the system service account");
    }
    return created;
  }

  /**
   * Value of the account's platform-held token, minted on first use. The
   * platform presents it to its own MCP gateway when it runs work as this
   * account; it is never shown to anyone.
   */
  static async ensurePlatformTokenValue(
    serviceAccountId: string,
  ): Promise<{ tokenId: string; value: string }> {
    const existing = await readPlatformToken(serviceAccountId);
    if (existing) return existing;

    const value = createTokenValue();
    const secret = await secretManager().createSecret(
      { token: value },
      `service-account-platform-token-${serviceAccountId}`,
      // Platform tokens are minted on demand, which a read-only BYOS vault
      // cannot take, so they always live in the database.
      true,
    );
    const [created] = await db
      .insert(schema.serviceAccountTokensTable)
      .values({
        serviceAccountId,
        name: PLATFORM_TOKEN_NAME,
        tokenHash: hashToken(value),
        tokenStart: value.slice(0, 16),
        secretId: secret.id,
      })
      .onConflictDoNothing()
      .returning({ id: schema.serviceAccountTokensTable.id });

    if (created) return { tokenId: created.id, value };

    // A concurrent call won the race; drop the secret nothing references.
    await secretManager().deleteSecret(secret.id);
    const winner = await readPlatformToken(serviceAccountId);
    if (!winner) {
      throw new Error("Failed to create the service account platform token");
    }
    return winner;
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
    if (!token.startsWith(ARCHESTRA_TOKEN_PREFIX)) return null;

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

    // Every gateway request on a token lands here, so an unconditional write
    // would turn the row into a lock hot spot. A burst refreshes it once.
    const cutoff = new Date(Date.now() - LAST_USED_REFRESH_INTERVAL_MS);
    if (!row.token.lastUsedAt || row.token.lastUsedAt < cutoff) {
      await db
        .update(schema.serviceAccountTokensTable)
        .set({ lastUsedAt: new Date() })
        .where(
          and(
            eq(schema.serviceAccountTokensTable.id, row.token.id),
            or(
              isNull(schema.serviceAccountTokensTable.lastUsedAt),
              lt(schema.serviceAccountTokensTable.lastUsedAt, cutoff),
            ),
          ),
        );
    }

    return row;
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
  stats: TokenStats,
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
    role: serviceAccount.role,
    teamId: serviceAccount.teamId,
    disabled: serviceAccount.disabled,
    createdAt: serviceAccount.createdAt,
    updatedAt: serviceAccount.updatedAt,
    tokenCount: stats.tokenCount,
    activeTokenCount: stats.activeTokenCount,
    lastUsedAt: stats.lastUsedAt,
    soonestExpiryAt: stats.soonestExpiryAt,
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

const SYSTEM_SERVICE_ACCOUNT_NAME = "System (built-in)";
const PLATFORM_TOKEN_NAME = "Platform gateway token";
const LAST_USED_REFRESH_INTERVAL_MS = 60_000;

async function findSystemServiceAccount(
  organizationId: string,
): Promise<SelectServiceAccount | null> {
  const [row] = await db
    .select()
    .from(schema.serviceAccountsTable)
    .where(
      and(
        eq(schema.serviceAccountsTable.organizationId, organizationId),
        eq(schema.serviceAccountsTable.isSystem, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function readPlatformToken(
  serviceAccountId: string,
): Promise<{ tokenId: string; value: string } | null> {
  const [row] = await db
    .select({
      id: schema.serviceAccountTokensTable.id,
      secretId: schema.serviceAccountTokensTable.secretId,
    })
    .from(schema.serviceAccountTokensTable)
    .where(
      and(
        eq(schema.serviceAccountTokensTable.serviceAccountId, serviceAccountId),
        isNotNull(schema.serviceAccountTokensTable.secretId),
      ),
    )
    .limit(1);
  if (!row?.secretId) return null;
  const secret = await secretManager().getSecret(row.secretId);
  const value = (secret?.secret as { token?: unknown } | undefined)?.token;
  return typeof value === "string" ? { tokenId: row.id, value } : null;
}

function createTokenValue(): string {
  return `${ARCHESTRA_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function hashToken(token: string): string {
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
