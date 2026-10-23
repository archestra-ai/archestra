import { z } from "zod";
import {
  type PermissionSubject,
  PermissionSubjectSchema,
} from "./resource-permissions";

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
 * Whether two `access` selections filter the same way, for reusing a list's
 * server seed. Order does not matter, and two absent selections match.
 */
export function isSameResourceAccess(
  a: readonly ResourceAccessRelation[] | undefined,
  b: readonly ResourceAccessRelation[] | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((relation) => b.includes(relation));
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

/**
 * The `sharedWith` list query parameter: comma-separated
 * {@link permissionSubjectKey} tokens, parsed into subjects. Keeps objects
 * whose own policy grants read to any of them. Absent means no filtering.
 */
export const ResourceSharedWithQuerySchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.split(",") : value),
    z
      .array(
        z.string().transform((key, ctx) => {
          const subject = parsePermissionSubjectKey(key);
          if (subject) return subject;
          ctx.addIssue({
            code: "custom",
            message: `Invalid subject "${key}": expected org, role:<id>, team:<id>, user:<id>, or serviceAccount:<id>`,
          });
          return z.NEVER;
        }),
      )
      .min(1),
  )
  .optional()
  .describe(
    "Keep only objects whose own permissions grant read to one of these subjects (comma-separated): org (the whole organization), role:<roleId>, team:<teamId>, user:<userId>, serviceAccount:<serviceAccountId>. Grants inherited from organization-wide permissions do not count. Omit for no filtering.",
  );

/**
 * The `owner` list query parameter: comma-separated user ids. Keeps objects
 * authored by any of them. Absent means no filtering.
 */
export const ResourceOwnerQuerySchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.split(",") : value),
    z.array(z.string().min(1)).min(1),
  )
  .optional()
  .describe(
    "Keep only objects authored by one of these user IDs (comma-separated). Narrows the rows the caller can already read. Omit for no filtering.",
  );

/**
 * A grant subject as one URL-safe token, for the `sharedWith` list query
 * parameter: `org` for the whole organization, otherwise `<type>:<id>` —
 * `role:<id>`, `team:<id>`, `user:<id>`, or `serviceAccount:<id>`.
 */
export function permissionSubjectKey(subject: PermissionSubject): string {
  return subject.type === "organization"
    ? "org"
    : `${subject.type}:${subject.id}`;
}

/**
 * The subject a {@link permissionSubjectKey} token names, or null when the
 * token is malformed. `organization` and `organization:*` read as `org`.
 */
export function parsePermissionSubjectKey(
  key: string,
): PermissionSubject | null {
  const trimmed = key.trim();
  if (
    trimmed === "org" ||
    trimmed === "organization" ||
    trimmed === "organization:*"
  )
    return { type: "organization", id: "*" };
  const separator = trimmed.indexOf(":");
  if (separator <= 0) return null;
  const parsed = PermissionSubjectSchema.safeParse({
    type: trimmed.slice(0, separator),
    id: trimmed.slice(separator + 1),
  });
  return parsed.success ? parsed.data : null;
}
