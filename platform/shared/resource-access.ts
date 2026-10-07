import { z } from "zod";

/**
 * How the caller reaches a listed object, for the "Show" filter every
 * grant-governed list offers:
 *
 * - `mine`: the caller is its author.
 * - `shared`: its own policy names the caller, or one of the caller's teams.
 * - `org`: its own policy reaches the whole organization (or a role).
 * - `others`: none of the above. The caller sees it only through authority
 *   over every object of the type, which is how an administrator sees other
 *   people's personal objects.
 *
 * An object can be in more than one relation. A filter keeps a row when the
 * row is in any selected relation.
 */
export const ResourceAccessRelationSchema = z.enum([
  "mine",
  "shared",
  "org",
  "others",
]);

export type ResourceAccessRelation = z.infer<
  typeof ResourceAccessRelationSchema
>;

export const RESOURCE_ACCESS_RELATIONS = ResourceAccessRelationSchema.options;

/**
 * What a list shows until the viewer changes the filter: everything except
 * objects the viewer reaches only through organization-wide authority.
 */
export const DEFAULT_RESOURCE_ACCESS_RELATIONS: ResourceAccessRelation[] = [
  "mine",
  "shared",
  "org",
];

/**
 * Whether `access` is the default selection, the one a list's server seed is
 * fetched with. Order does not matter.
 */
export function isDefaultResourceAccess(
  access: readonly ResourceAccessRelation[] | undefined,
): boolean {
  return (
    !!access &&
    access.length === DEFAULT_RESOURCE_ACCESS_RELATIONS.length &&
    DEFAULT_RESOURCE_ACCESS_RELATIONS.every((relation) =>
      access.includes(relation),
    )
  );
}

/**
 * The `access` list query parameter, comma-separated. Absent means no
 * filtering, so API clients that predate it keep seeing every row.
 */
export const ResourceAccessQuerySchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.split(",") : value),
    z.array(ResourceAccessRelationSchema).min(1),
  )
  .optional()
  .describe(
    "Keep only objects the caller reaches in one of these ways (comma-separated): mine (authored by the caller), shared (shared with the caller or one of their teams), org (shared with the organization), others (visible only through organization-wide authority). Omit for every readable object.",
  );
