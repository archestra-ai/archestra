import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CreatedBy } from "@archestra/shared";
import {
  ARCHESTRA_TOKEN_PREFIX,
  MEMBER_ROLE_NAME,
  type Permissions,
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
  max,
  or,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
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

class ServiceAccountModel {
  static readonly MAX_TOKENS_PER_SERVICE_ACCOUNT = 50;

  static async listByOrganizationId(
    organizationId: string,
    labels?: Record<string, string[]>,
  ): Promise<ServiceAccountResponse[]> {
    const labelFilteredIds = labels
      ? await ServiceAccountLabelModel.getIdsMatchingLabels(labels)
      : null;
    if (labelFilteredIds?.length === 0) {
      return [];
    }

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
        eq(tokens.serviceAccountId, schema.serviceAccountsTable.id),
      )
      .where(
        and(
          eq(schema.serviceAccountsTable.organizationId, organizationId),
          ...(labelFilteredIds
            ? [inArray(schema.serviceAccountsTable.id, labelFilteredIds)]
            : []),
        ),
      )
      .groupBy(schema.serviceAccountsTable.id)
      .orderBy(desc(schema.serviceAccountsTable.createdAt));

    const [labelsById, creators] = await Promise.all([
      ServiceAccountLabelModel.getLabelsForMany(
        rows.map(({ serviceAccount }) => serviceAccount.id),
      ),
      CreatedByModel.resolve(
        rows.map(({ serviceAccount }) => serviceAccount.createdBy),
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
        ),
      )
      .limit(1);

    if (!serviceAccount) return null;

    const tokens = await db
      .select()
      .from(schema.serviceAccountTokensTable)
      .where(eq(schema.serviceAccountTokensTable.serviceAccountId, id))
      .orderBy(desc(schema.serviceAccountTokensTable.createdAt));

    return {
      ...normalizeServiceAccount(
        serviceAccount,
        summarizeTokens(tokens),
        await CreatedByModel.resolve([serviceAccount.createdBy]),
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
      role: serviceAccount.role,
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
    labels?: LabelWithDetails[];
    /**
     * Required, but nullable: every interactive create knows its user, and
     * making the parameter mandatory stops a new call path from silently
     * dropping the creator. Non-interactive callers (seeding, tests) say `null`
     * rather than being allowed to forget.
     */
    createdBy: string | null;
  }): Promise<ServiceAccountDetailResponse> {
    const [serviceAccount] = await db
      .insert(schema.serviceAccountsTable)
      .values({
        organizationId: params.organizationId,
        name: params.name,
        role: params.role,
        createdBy: params.createdBy,
      })
      .returning();

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
        await CreatedByModel.resolve([serviceAccount.createdBy]),
        await ServiceAccountLabelModel.getLabelsFor(serviceAccount.id),
      ),
      tokens: [],
    };
  }

  static async update(
    id: string,
    organizationId: string,
    data: Partial<Pick<SelectServiceAccount, "name" | "role" | "disabled">> & {
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
    const deleted = await db
      .delete(schema.serviceAccountsTable)
      .where(
        and(
          eq(schema.serviceAccountsTable.id, id),
          eq(schema.serviceAccountsTable.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.serviceAccountsTable.id });

    return deleted.length > 0;
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

    await db
      .update(schema.serviceAccountTokensTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.serviceAccountTokensTable.id, row.token.id));

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
    createdBy: lookupCreator(creators, serviceAccount.createdBy),
    labels,
    id: serviceAccount.id,
    organizationId: serviceAccount.organizationId,
    name: serviceAccount.name,
    role: serviceAccount.role,
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
