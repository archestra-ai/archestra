import { z } from "zod";

export const ResourceVisibilityScopeSchema = z.enum([
  "personal",
  "team",
  "org",
]);
export type ResourceVisibilityScope = z.infer<
  typeof ResourceVisibilityScopeSchema
>;
