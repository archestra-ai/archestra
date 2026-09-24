import { z } from "zod";

export type { ResourceVisibilityScope } from "@archestra/shared";
export { ResourceVisibilityScopeSchema } from "@archestra/shared";

/**
 * A create-body field that once said who could reach the new object. Access
 * is set with `initialGrants` alone now, so the field is refused with a 400
 * rather than silently dropped.
 */
export const RetiredSharingFieldSchema = z
  .never({
    error:
      "This field is retired. Set who can reach the object with initialGrants.",
  })
  .optional();

/**
 * An update-body field that once changed who could reach the object. Access
 * changes through the object's permissions now, so the field is refused with
 * a 400 rather than stored where nothing reads it.
 */
export const RetiredSharingUpdateFieldSchema = z
  .never({
    error:
      "This field is retired. Change who can reach the object in its permissions.",
  })
  .optional();
