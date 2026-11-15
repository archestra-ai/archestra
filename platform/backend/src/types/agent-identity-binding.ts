// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database/schema";

/** The body of `PUT /api/agents/:id/identity-bindings`: the full set. */
export const ReplaceAgentIdentityBindingsSchema = z.object({
  bindings: z
    .array(
      createSelectSchema(schema.agentIdentityBindingsTable)
        .pick({ identityProviderId: true, externalId: true })
        .extend({
          identityProviderId: z.string().min(1),
          externalId: z.string().trim().min(1).max(255),
        }),
    )
    .max(50),
});

/** One binding as the API takes and returns it. */
export type AgentIdentityBinding = z.infer<
  typeof ReplaceAgentIdentityBindingsSchema
>["bindings"][number];
