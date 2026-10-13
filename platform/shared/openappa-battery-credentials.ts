import { z } from "zod";

/**
 * What the battery credential card shows for each battery: what its helpers
 * buy, how to make the token, and the variables `[credentials]` binds.
 */
export const BatteryCredentialRequestSchema = z.object({
  batteries: z
    .array(
      z.object({
        name: z.string(),
        title: z.string(),
        benefit: z.string().nullable(),
        setup: z.array(z.string()),
        credentials: z.array(z.string()),
      }),
    )
    .min(1),
});

export type BatteryCredentialRequest = z.infer<
  typeof BatteryCredentialRequestSchema
>;
