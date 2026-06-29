import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const UserSchema = createSelectSchema(schema.usersTable);
const UpdateUserSchema = createUpdateSchema(schema.usersTable);
const InsertUserSchema = createInsertSchema(schema.usersTable);

export type User = z.infer<typeof UserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
export type InsertUser = z.infer<typeof InsertUserSchema>;
