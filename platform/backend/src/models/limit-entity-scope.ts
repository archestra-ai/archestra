import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { schema } from "@/database";
import { type LimitEntityType, LimitEntityTypeSchema } from "@/types/limit";

/** Stable bind shape; callers own fresh arrays and no query results are cached. */
export function limitEntityParameters(
  entities: Partial<Record<LimitEntityType, string | readonly string[]>>,
) {
  return Object.fromEntries(
    LimitEntityTypeSchema.options.map((type) => {
      const ids = entities[type];
      return [
        type,
        ids === undefined ? [] : typeof ids === "string" ? [ids] : [...ids],
      ];
    }),
  ) as Record<LimitEntityType, string[]>;
}

export function limitEntitiesCondition(): SQL {
  return or(
    ...LimitEntityTypeSchema.options.map((type) =>
      and(
        eq(schema.limitsTable.entityType, type),
        sql`${schema.limitsTable.entityId} = ANY(${sql.placeholder(type)}::text[])`,
      ),
    ),
  ) as SQL;
}
