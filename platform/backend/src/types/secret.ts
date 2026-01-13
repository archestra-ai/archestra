import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * The secret column stores authentication data in flexible JSON format:
 * - For OAuth: { "access_token": "...", "refresh_token": "...", "expires_in": ..., "token_type": "Bearer" }
 * - For Bearer Tokens: { "access_token": "token_value" } (sent as "Authorization: Bearer <token>")
 * - For Raw Tokens: { "raw_access_token": "token_value" } (sent as "Authorization: <token>")
 *
 * TODO: we should make this a strongly typed discriminated union of the possible secret types...
 */
export const SecretValueSchema = z.record(z.string(), z.unknown());

export const SelectSecretSchema = createSelectSchema(schema.secretsTable, {
  secret: SecretValueSchema,
});
export const InsertSecretSchema = createInsertSchema(schema.secretsTable, {
  secret: SecretValueSchema,
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const UpdateSecretSchema = createUpdateSchema(schema.secretsTable, {
  secret: SecretValueSchema,
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SecretValue = z.infer<typeof SecretValueSchema>;
export type SelectSecret = z.infer<typeof SelectSecretSchema>;
export type InsertSecret = z.infer<typeof InsertSecretSchema>;
export type UpdateSecret = z.infer<typeof UpdateSecretSchema>;

/**
 * Special format for BYOS vault secret references.
 * Format: "vault/path#key_name"
 * Example: "secret/data/api-keys#access_token"
 *
 * The hash separator (#) separates the Vault path from the key name within that secret.
 */
export type VaultSecretReference = `${string}#${string}`;

/**
 * Parse a vault secret reference into path and key components
 */
export function parseVaultSecretReference(ref: VaultSecretReference): {
  path: string;
  key: string;
} {
  const hashIndex = ref.indexOf("#");
  return {
    path: ref.substring(0, hashIndex),
    key: ref.substring(hashIndex + 1),
  };
}
