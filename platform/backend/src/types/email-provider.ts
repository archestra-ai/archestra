import { z } from "zod";

/**
 * Supported email provider types
 */
export const EmailProviderTypeSchema = z.enum(["outlook"]);
export type EmailProviderType = z.infer<typeof EmailProviderTypeSchema>;
