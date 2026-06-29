import { z } from "zod";

/**
 * Supported email provider types
 *
 * This is in a separate file to avoid circular dependencies.
 * config.ts imports this, and types/incoming-email.ts imports from database,
 * which imports config.ts - so they need to be separate.
 */
export const EmailProviderTypeSchema = z.enum(["outlook"]);
export type EmailProviderType = z.infer<typeof EmailProviderTypeSchema>;
