import type { AuthContext } from "@better-auth/core";
import { createUpdateSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

const UpdateSessionSchema = createUpdateSchema(schema.sessionsTable);

export type UpdateSession = z.infer<typeof UpdateSessionSchema>;

type BetterAuthSessionContext = AuthContext["session"];
export type BetterAuthSession =
  NonNullable<BetterAuthSessionContext>["session"];
export type BetterAuthSessionUser =
  NonNullable<BetterAuthSessionContext>["user"];
