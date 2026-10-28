import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

const SelectJiraChatOpsIdentitySchema = createSelectSchema(
  schema.jiraChatOpsIdentitiesTable,
);
export type JiraChatOpsIdentity = z.infer<
  typeof SelectJiraChatOpsIdentitySchema
>;
