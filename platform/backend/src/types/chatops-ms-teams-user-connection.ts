import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectChatOpsMsTeamsUserConnectionSchema = createSelectSchema(
  schema.chatopsMsTeamsUserConnectionsTable,
);

export type ChatOpsMsTeamsUserConnection = z.infer<
  typeof SelectChatOpsMsTeamsUserConnectionSchema
>;

/** What a Teams user connection keeps in the secrets manager. */
export const MsTeamsUserTokensSchema = z.object({
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1),
  /** Epoch milliseconds after which the access token is no longer used. */
  accessTokenExpiresAt: z.number(),
});

export type MsTeamsUserTokens = z.infer<typeof MsTeamsUserTokensSchema>;
