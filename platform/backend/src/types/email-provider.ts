import { z } from "zod";

/**
 * Supported email provider types
 *
 * This is in a separate file from incoming-email.ts to avoid circular dependencies.
 * incoming-email.ts imports from @/database, which imports from @/config,
 * and @/config needs EmailProviderTypeSchema.
 */
export const EmailProviderTypeSchema = z.enum(["outlook"]);
export type EmailProviderType = z.infer<typeof EmailProviderTypeSchema>;
