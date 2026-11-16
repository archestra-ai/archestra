import { z } from "zod";

/** Snapshot the selected binding; editing an Agent must not grant a live run new access. */
const RenewableCredentialSchema = z.object({
  credentialId: z.string().min(1),
  scope: z.enum(["personal", "organization"]).optional(),
  value: z.string(),
  expiresAt: z.number().finite(),
  /**
   * Set once the person was told this personal connection stopped working,
   * so each reconcile tick does not post again. Cleared when it works again.
   */
  reconnectNotified: z.boolean().optional(),
});

export const RenewableCredentialBundleSchema = z.object({
  taskId: z.string().uuid(),
  credentials: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    RenewableCredentialSchema,
  ),
});

export type RenewableCredential = z.infer<typeof RenewableCredentialSchema>;
