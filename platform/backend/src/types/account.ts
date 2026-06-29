import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const AccountSchema = createSelectSchema(schema.accountsTable);
const UpdateAccountSchema = createUpdateSchema(schema.accountsTable);
const InsertAccountSchema = createInsertSchema(schema.accountsTable);

export type Account = z.infer<typeof AccountSchema>;
export type UpdateAccount = z.infer<typeof UpdateAccountSchema>;
export type InsertAccount = z.infer<typeof InsertAccountSchema>;
