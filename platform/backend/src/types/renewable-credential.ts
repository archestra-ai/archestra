import { z } from "zod";

/** Snapshot the selected binding; editing an Agent must not grant a live run new access. */
const RenewableCredentialSchema = z.object({
  credentialId: z.string().min(1),
  scope: z.enum(["personal", "organization"]).optional(),
  value: z.string(),
  expiresAt: z.number().finite(),
});

export const RenewableCredentialBundleSchema = z.object({
  taskId: z.string().uuid(),
  credentials: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    RenewableCredentialSchema,
  ),
});

export type RenewableCredential = z.infer<typeof RenewableCredentialSchema>;
