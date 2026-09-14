import type { CreatedBy } from "@archestra/shared";
import { and, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { ApiError } from "@/types";

/**
 * Resolves creator user ids into the uniform `CreatedBy` shape the "Created by"
 * column renders across every major object.
 *
 * A batch resolver rather than a join per entity, on purpose. Every one of these
 * tables already stores the creator on the row — under four different names
 * (`author_id`, `user_id`, `uploaded_by`, `created_by`) — and their list queries
 * are among the hairiest in the codebase: aggregates, `groupBy`, existing joins
 * onto `user` for other reasons, `UNION`-shaped scope filters. Threading a
 * fifth join through each of those to fetch three columns would be a lot of
 * risk for no extra information. One extra query per list page, keyed on ids
 * the rows already carry, costs less than any of it and cannot perturb the
 * ordering, grouping or pagination of the query it decorates.
 *
 * Unknown ids are simply absent from the map, so a row whose author was deleted
 * between the two queries reads as "no creator" instead of failing the request.
 */
class CreatedByModel {
  /** Normalize an authenticated principal before writing a human-only FK. */
  static async forInsert<
    K extends "authorId" | "createdBy" | "uploadedBy" | "ownerId",
    const T extends {
      organizationId?: string;
      scope?: string;
      visibility?: string;
    } & Partial<Record<K, string | null>>,
  >({
    data,
    userIdField,
    transaction,
  }: {
    data: T;
    userIdField: K;
    transaction?: Transaction;
  }): Promise<
    Omit<T, K | "createdByServiceAccountId"> &
      Record<K, string | null | undefined> & {
        createdByServiceAccountId: string | null;
      }
  > {
    const actorId = data[userIdField];
    if (!actorId?.startsWith(SERVICE_ACCOUNT_PREFIX)) {
      return {
        ...data,
        [userIdField]: actorId,
        createdByServiceAccountId: null,
      };
    }
    if (data.scope === "personal" || data.visibility === "private") {
      throw new ApiError(
        400,
        "Service accounts cannot create personal resources. Use org or team scope.",
      );
    }
    const serviceAccountId = actorId.slice(SERVICE_ACCOUNT_PREFIX.length);
    const [account] = await (transaction ?? db)
      .select({ id: schema.serviceAccountsTable.id })
      .from(schema.serviceAccountsTable)
      .where(
        and(
          eq(schema.serviceAccountsTable.id, serviceAccountId),
          eq(
            schema.serviceAccountsTable.organizationId,
            data.organizationId ?? "",
          ),
        ),
      );
    if (!account)
      throw new ApiError(
        403,
        "The creator must belong to the resource organization",
      );
    return {
      ...data,
      [userIdField]: null,
      createdByServiceAccountId: account.id,
    };
  }

  /** A stable principal id for batch resolution; it confers no ownership. */
  static id(
    row: object,
    humanId: string | null | undefined,
  ): string | null | undefined {
    return "createdByServiceAccountId" in row &&
      typeof row.createdByServiceAccountId === "string"
      ? `${SERVICE_ACCOUNT_PREFIX}${row.createdByServiceAccountId}`
      : humanId;
  }

  static async resolve(
    userIds: readonly (string | null | undefined)[],
  ): Promise<Map<string, CreatedBy>> {
    const ids = [...new Set(userIds.filter((id): id is string => !!id))];
    if (ids.length === 0) {
      return new Map();
    }

    const humanIds = ids.filter((id) => !id.startsWith(SERVICE_ACCOUNT_PREFIX));
    const serviceAccountIds = ids
      .filter((id) => id.startsWith(SERVICE_ACCOUNT_PREFIX))
      .map((id) => id.slice(SERVICE_ACCOUNT_PREFIX.length));
    const accounts = serviceAccountIds.length
      ? await db
          .select({
            id: schema.serviceAccountsTable.id,
            name: schema.serviceAccountsTable.name,
          })
          .from(schema.serviceAccountsTable)
          .where(inArray(schema.serviceAccountsTable.id, serviceAccountIds))
      : [];
    const rows = humanIds.length
      ? await db
          .select({
            id: schema.usersTable.id,
            name: schema.usersTable.name,
            email: schema.usersTable.email,
          })
          .from(schema.usersTable)
          .where(inArray(schema.usersTable.id, humanIds))
      : [];

    const creators = new Map<string, CreatedBy>(
      rows.map((row) => [
        row.id,
        // The columns are `notNull` in the schema but empty strings happen
        // (SSO-provisioned accounts that never set a display name), and an
        // empty label renders as a blank cell. Normalising here means no
        // caller has to remember to.
        { id: row.id, name: row.name || null, email: row.email || null },
      ]),
    );
    for (const account of accounts) {
      const id = `${SERVICE_ACCOUNT_PREFIX}${account.id}`;
      creators.set(id, {
        id,
        name: account.name,
        email: null,
        type: "service_account",
      });
    }
    return creators;
  }

  /**
   * Resolve the creators referenced by `rows` and hand each row back with a
   * `createdBy` field holding the resolved identity.
   *
   * `creatorIdOf` names the column that stores it, which differs per entity
   * (`author_id`, `user_id`, `uploaded_by`, `created_by`). Where that column is
   * already called `createdBy`, the resolved object replaces the bare id in
   * place, so nothing has to strip the id afterwards.
   */
  static async attach<T extends object>(
    rows: T[],
    creatorIdOf: (row: T) => string | null | undefined,
  ): Promise<(Omit<T, "createdBy"> & { createdBy: CreatedBy | null })[]> {
    const creators = await CreatedByModel.resolve(
      rows.map((row) => CreatedByModel.id(row, creatorIdOf(row))),
    );
    return rows.map((row) => ({
      ...row,
      createdBy: lookupCreator(
        creators,
        CreatedByModel.id(row, creatorIdOf(row)),
      ),
    }));
  }

  /** The single-row case, for create/update/detail routes. */
  static async resolveOne(
    userId: string | null | undefined,
  ): Promise<CreatedBy | null> {
    return lookupCreator(await CreatedByModel.resolve([userId]), userId);
  }
}

export default CreatedByModel;

/**
 * Reads one creator out of a resolved map, collapsing "no creator recorded" and
 * "creator no longer exists" into the same `null` — the distinction is not one
 * any surface can act on, and both mean nobody to contact.
 */
export function lookupCreator(
  creators: Map<string, CreatedBy>,
  userId: string | null | undefined,
): CreatedBy | null {
  return (userId && creators.get(userId)) || null;
}

const SERVICE_ACCOUNT_PREFIX = "service-account:";
