import { z } from "zod";

/**
 * Which encryption key a canary row verifies: the stored-secrets key
 * (ARCHESTRA_SECRETS_ENCRYPTION_SECRET) or the enterprise content-at-rest key
 * (ARCHESTRA_CONTENT_ENCRYPTION_SECRET).
 */
export const EncryptionKeyPurposeSchema = z.enum(["secrets", "content"]);
export type EncryptionKeyPurpose = z.infer<typeof EncryptionKeyPurposeSchema>;
