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
