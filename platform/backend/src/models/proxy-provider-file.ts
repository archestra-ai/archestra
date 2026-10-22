import { and, asc, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertProxyProviderFile,
  ProxyProviderFile,
} from "@/types/proxy-provider-file";

export interface ProxyFileScope {
  organizationId: string;
  principalKind: string;
  principalId: string;
  provider: string;
  accountBinding: string;
}

class ProxyProviderFileModel {
  static async create(
    values: InsertProxyProviderFile,
  ): Promise<ProxyProviderFile> {
    const [row] = await db
      .insert(schema.proxyProviderFilesTable)
      .values(values)
      .returning();
    return row;
  }

  static async findOwned(
    id: string,
    scope: ProxyFileScope,
  ): Promise<ProxyProviderFile | null> {
    const [row] = await db
      .select()
      .from(schema.proxyProviderFilesTable)
      .where(
        and(eq(schema.proxyProviderFilesTable.id, id), owned(scope), active()),
      );
    return row ?? null;
  }

  static async listOwned(
    scope: ProxyFileScope,
    options: { limit: number; after?: string; order: "asc" | "desc" },
  ): Promise<ProxyProviderFile[]> {
    const table = schema.proxyProviderFilesTable;
    const cursor = options.after
      ? await ProxyProviderFileModel.findOwned(options.after, scope)
      : null;
    if (options.after && !cursor) return [];
    const compare = options.order === "asc" ? gt : lt;
    return db
      .select()
      .from(table)
      .where(
        and(
          owned(scope),
          active(),
          cursor
            ? or(
                compare(table.createdAt, cursor.createdAt),
                and(
                  eq(table.createdAt, cursor.createdAt),
                  compare(table.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        options.order === "asc" ? asc(table.createdAt) : desc(table.createdAt),
        options.order === "asc" ? asc(table.id) : desc(table.id),
      )
      .limit(options.limit);
  }

  static async deleteOwned(id: string, scope: ProxyFileScope): Promise<void> {
    await db
      .delete(schema.proxyProviderFilesTable)
      .where(and(eq(schema.proxyProviderFilesTable.id, id), owned(scope)));
  }
}

export default ProxyProviderFileModel;

function active() {
  return or(
    isNull(schema.proxyProviderFilesTable.expiresAt),
    gt(schema.proxyProviderFilesTable.expiresAt, new Date()),
  );
}

function owned(scope: ProxyFileScope) {
  const table = schema.proxyProviderFilesTable;
  return and(
    eq(table.organizationId, scope.organizationId),
    eq(table.principalKind, scope.principalKind),
    eq(table.principalId, scope.principalId),
    eq(table.provider, scope.provider),
    eq(table.accountBinding, scope.accountBinding),
  );
}
