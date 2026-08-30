import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/** Who owns a reusable credential used by Background execution containers. */
export const ExecutionCredentialConnectionScopeSchema = z.enum([
  "personal",
  "organization",
]);
export type ExecutionCredentialConnectionScope = z.infer<
  typeof ExecutionCredentialConnectionScopeSchema
>;

export const SelectExecutionCredentialConnectionSchema = createSelectSchema(
  schema.executionCredentialConnectionsTable,
).extend({ scope: ExecutionCredentialConnectionScopeSchema });

export type ExecutionCredentialConnection = z.infer<
  typeof SelectExecutionCredentialConnectionSchema
>;
