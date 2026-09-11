import { PaginationMetaSchema } from "@archestra/shared";
import { z } from "zod";
import { PublicA2aRemoteAgentSchema } from "./a2a-outbound";
import { AgentListItemSchema } from "./agent";

export const AgentCatalogRowSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent"),
    value: AgentListItemSchema,
  }),
  z.object({
    type: z.literal("external"),
    value: PublicA2aRemoteAgentSchema,
  }),
]);

export const AgentCatalogResponseSchema = z.object({
  data: z.array(AgentCatalogRowSchema),
  pagination: PaginationMetaSchema,
  totals: z.object({
    agents: z.number().int().nonnegative(),
    externalAgents: z.number().int().nonnegative(),
  }),
});

export type AgentCatalogRow = z.infer<typeof AgentCatalogRowSchema>;
export type AgentCatalogResponse = z.infer<typeof AgentCatalogResponseSchema>;
