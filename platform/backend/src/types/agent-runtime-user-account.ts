import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import agentRuntimeUserAccountsTable from "@/database/agent-runtime-user-accounts";

export const AgentRuntimeAccountAuthenticationSchema = z.enum([
  "provider",
  "subscription",
]);
export type AgentRuntimeAccountAuthentication = z.infer<
  typeof AgentRuntimeAccountAuthenticationSchema
>;

export const SelectAgentRuntimeUserAccountSchema = createSelectSchema(
  agentRuntimeUserAccountsTable,
  { authentication: AgentRuntimeAccountAuthenticationSchema },
);
export type AgentRuntimeUserAccount = z.infer<
  typeof SelectAgentRuntimeUserAccountSchema
>;
