import type { AuthContext } from "@better-auth/core";
import { createInsertSchema, createUpdateSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const UpdateSessionSchema = createUpdateSchema(schema.sessionsTable);
export const InsertSessionSchema = createInsertSchema(schema.sessionsTable);

export type UpdateSession = z.infer<typeof UpdateSessionSchema>;
export type InsertSession = z.infer<typeof InsertSessionSchema>;

type BetterAuthSessionContext = AuthContext["session"];
export type BetterAuthSession =
  NonNullable<BetterAuthSessionContext>["session"];
export type BetterAuthSessionUser =
  NonNullable<BetterAuthSessionContext>["user"];
