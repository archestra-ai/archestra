import {
  type PermissionSubject,
  parsePermissionSubjectKey,
  type ResourceAccessRelation,
  ResourceAccessRelationSchema,
} from "@archestra/shared";
import { z } from "zod";
import {
  type ResourceAccessSelection,
  resourceAccessSelection,
} from "@/models/resource-permission-subject";

/**
 * The `access` argument of the list tools, mirroring the `access` query
 * parameter of the matching REST lists. An array rather than the REST
 * comma-separated string, so a model passes structured values.
 */
export function resourceAccessToolArg(params: { examplePlural: string }) {
  return z
    .array(ResourceAccessRelationSchema)
    .min(1)
    .optional()
    .describe(
      "Only return items the caller reaches in one of these ways: " +
        "mine (created by the caller), " +
        "shared (shared with the caller or one of their teams), " +
        "org (shared with the whole organization), " +
        "others (not shared with the caller; visible only through admin access). " +
        `Omit for everything the caller can read. Use ["mine"] for "my ${params.examplePlural}".`,
    );
}

/**
 * The `shared_with` argument of the list tools, mirroring the `sharedWith`
 * query parameter of the matching REST lists.
 */
export const resourceSharedWithToolArg = z
  .array(
    z.string().refine((key) => parsePermissionSubjectKey(key) !== null, {
      message:
        "Expected org, role:<id>, team:<id>, user:<id>, or serviceAccount:<id>",
    }),
  )
  .min(1)
  .optional()
  .describe(
    "Only return items whose own permissions grant read to one of these subjects: " +
      "org (the whole organization), role:<roleId>, team:<teamId>, user:<userId>, serviceAccount:<serviceAccountId>. " +
      "Omit for no filtering.",
  );

/**
 * The `owner_ids` argument of the list tools, mirroring the `owner` query
 * parameter of the matching REST lists.
 */
export const resourceOwnerIdsToolArg = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe(
    "Only return items created by one of these user IDs. Omit for no filtering.",
  );

/**
 * What a list tool's `access`, `shared_with`, and `owner_ids` arguments
 * select, or undefined when none of them filters.
 */
export function toolAccessSelection(args: {
  access?: ResourceAccessRelation[];
  shared_with?: string[];
  owner_ids?: string[];
}): ResourceAccessSelection | undefined {
  return resourceAccessSelection({
    access: args.access,
    sharedWith: args.shared_with
      ?.map(parsePermissionSubjectKey)
      .filter((subject): subject is PermissionSubject => subject !== null),
    owner: args.owner_ids,
  });
}
