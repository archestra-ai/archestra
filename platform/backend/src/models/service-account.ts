import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  isNull,
  or,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  SelectServiceAccount,
  SelectServiceAccountToken,
  ServiceAccountDetailResponse,
  ServiceAccountResponse,
  ServiceAccountTokenResponse,
} from "@/types";
import OrganizationRoleModel from "./organization-role";

class ServiceAccountModel {
  static readonly MAX_TOKENS_PER_SERVICE_ACCOUNT = 50;

  static async listByOrganizationId(
    organizationId: string,
  ): Promise<ServiceAccountResponse[]> {
    const rows = await db
      .select({
        serviceAccount: schema.serviceAccountsTable,
        tokenCount: count(schema.serviceAccountTokensTable.id),
      })
      .from(schema.serviceAccountsTable)
      .leftJoin(
        schema.serviceAccountTokensTable,
        eq(
          schema.serviceAccountTokensTable.serviceAccountId,
          schema.serviceAccountsTable.id,
        ),
      )
      .where(eq(schema.serviceAccountsTable.organizationId, organizationId))
      .groupBy(schema.serviceAccountsTable.id)
      .orderBy(desc(schema.serviceAccountsTable.createdAt));

    return rows.map(({ serviceAccount, tokenCount }) =>
      normalizeServiceAccount(serviceAccount, tokenCount),
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
      ...normalizeServiceAccount(serviceAccount, tokens.length),
      tokens: tokens.map(normalizeToken),
    };
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
  }): Promise<ServiceAccountDetailResponse> {
    const [serviceAccount] = await db
      .insert(schema.serviceAccountsTable)
      .values({
        organizationId: params.organizationId,
        name: params.name,
        role: params.role,
      })
      .returning();

    return {
      ...normalizeServiceAccount(serviceAccount, 0),
      tokens: [],
    };
  }

  static async update(
    id: string,
    organizationId: string,
    data: Partial<Pick<SelectServiceAccount, "name" | "role" | "disabled">>,
  ): Promise<ServiceAccountDetailResponse | null> {
    const [serviceAccount] = await db
      .update(schema.serviceAccountsTable)
      .set(data)
      .where(
        and(
          eq(schema.serviceAccountsTable.id, id),
          eq(schema.serviceAccountsTable.organizationId, organizationId),
        ),
      )
      .returning();

    if (!serviceAccount) return null;
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
  tokenCount: number,
): ServiceAccountResponse {
  return {
    id: serviceAccount.id,
    organizationId: serviceAccount.organizationId,
    name: serviceAccount.name,
    role: serviceAccount.role,
    disabled: serviceAccount.disabled,
    createdAt: serviceAccount.createdAt,
    updatedAt: serviceAccount.updatedAt,
    tokenCount,
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
