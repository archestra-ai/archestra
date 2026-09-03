import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/** Who owns a reusable credential used by Agent Runtime containers. */
export const RuntimeCredentialConnectionScopeSchema = z.enum([
  "personal",
  "organization",
]);
export type RuntimeCredentialConnectionScope = z.infer<
  typeof RuntimeCredentialConnectionScopeSchema
>;

export const SelectRuntimeCredentialConnectionSchema = createSelectSchema(
  schema.runtimeCredentialConnectionsTable,
).extend({ scope: RuntimeCredentialConnectionScopeSchema });

export type RuntimeCredentialConnection = z.infer<
  typeof SelectRuntimeCredentialConnectionSchema
>;
