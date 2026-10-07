import { ResourceAccessRelationSchema } from "@archestra/shared";
import { z } from "zod";

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
