import type { CreatedBy } from "@archestra/shared";
import { inArray } from "drizzle-orm";
import db, { schema } from "@/database";

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
  static async resolve(
    userIds: readonly (string | null | undefined)[],
  ): Promise<Map<string, CreatedBy>> {
    const ids = [...new Set(userIds.filter((id): id is string => !!id))];
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({
        id: schema.usersTable.id,
        name: schema.usersTable.name,
        email: schema.usersTable.email,
      })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, ids));

    return new Map(
      rows.map((row) => [
        row.id,
        // The columns are `notNull` in the schema but empty strings happen
        // (SSO-provisioned accounts that never set a display name), and an
        // empty label renders as a blank cell. Normalising here means no
        // caller has to remember to.
        { id: row.id, name: row.name || null, email: row.email || null },
      ]),
    );
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
