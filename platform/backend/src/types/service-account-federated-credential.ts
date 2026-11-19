// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database/schema";

/**
 * Claims a trust policy cannot name as a condition: the issuer, audience and
 * subject have their own fields, and the time claims are checked for every
 * token anyway. A condition on `jti` could only ever match one token.
 */
const RESERVED_CLAIMS = new Set([
  "iss",
  "aud",
  "sub",
  "exp",
  "nbf",
  "iat",
  "jti",
]);
const MAX_CLAIM_CONDITIONS = 10;

/**
 * Top-level claim name -> value it must equal. Values are compared exactly,
 * against string, number and boolean claims; arrays and objects never match.
 */
export const FederatedCredentialClaimConditionsSchema = z
  .record(
    z
      .string()
      .regex(
        /^[A-Za-z0-9_.:-]{1,128}$/,
        "Claim names use letters, digits, and _ . : -",
      ),
    z.string().min(1).max(1024),
  )
  .refine(
    (conditions) => Object.keys(conditions).length <= MAX_CLAIM_CONDITIONS,
    {
      message: `At most ${MAX_CLAIM_CONDITIONS} claim conditions`,
    },
  )
  .refine(
    (conditions) =>
      Object.keys(conditions).every((claim) => !RESERVED_CLAIMS.has(claim)),
    {
      message:
        "iss, aud and sub have their own fields; exp, nbf, iat and jti cannot be conditions",
    },
  );
export type FederatedCredentialClaimConditions = z.infer<
  typeof FederatedCredentialClaimConditionsSchema
>;

const IssuerSchema = z.string().trim().max(2048).refine(isHttpsIssuer, {
  message:
    "The issuer must be an https URL without a query, fragment, or credentials",
});

export const SelectServiceAccountFederatedCredentialSchema = createSelectSchema(
  schema.serviceAccountFederatedCredentialsTable,
  {
    claimConditions: FederatedCredentialClaimConditionsSchema,
  },
);
export type SelectServiceAccountFederatedCredential = z.infer<
  typeof SelectServiceAccountFederatedCredentialSchema
>;

export const ServiceAccountFederatedCredentialResponseSchema =
  SelectServiceAccountFederatedCredentialSchema.pick({
    id: true,
    serviceAccountId: true,
    name: true,
    issuer: true,
    audience: true,
    subject: true,
    claimConditions: true,
    lastUsedAt: true,
    createdAt: true,
    updatedAt: true,
  });
export type ServiceAccountFederatedCredentialResponse = z.infer<
  typeof ServiceAccountFederatedCredentialResponseSchema
>;

export const CreateServiceAccountFederatedCredentialBodySchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    issuer: IssuerSchema,
    audience: z.string().trim().min(1).max(1024),
    subject: z.string().trim().min(1).max(1024),
    claimConditions: FederatedCredentialClaimConditionsSchema.optional(),
  })
  .strict();

export const UpdateServiceAccountFederatedCredentialBodySchema =
  CreateServiceAccountFederatedCredentialBodySchema.partial().strict();
export type UpdateServiceAccountFederatedCredentialBody = z.infer<
  typeof UpdateServiceAccountFederatedCredentialBodySchema
>;

export const ServiceAccountFederatedCredentialParamsSchema = z.object({
  id: z.string().uuid(),
  credentialId: z.string().uuid(),
});

// === Token exchange (RFC 8693)

export const TOKEN_EXCHANGE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
export const ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

/**
 * Lenient on purpose: a missing or wrong field is answered with an RFC 6749
 * error code by the handler, not with a schema validation error.
 */
export const WorkloadIdentityTokenRequestSchema = z.object({
  grant_type: z.string().max(256).optional(),
  subject_token: z.string().max(16_384).optional(),
  subject_token_type: z.string().max(256).optional(),
  requested_token_type: z.string().max(256).optional(),
  /** The service account the caller wants to act as. */
  service_account_id: z.string().max(64).optional(),
});
export type WorkloadIdentityTokenRequest = z.infer<
  typeof WorkloadIdentityTokenRequestSchema
>;

export const WorkloadIdentityTokenResponseSchema = z.object({
  access_token: z.string(),
  issued_token_type: z.literal(ACCESS_TOKEN_TYPE),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
});
export type WorkloadIdentityTokenResponse = z.infer<
  typeof WorkloadIdentityTokenResponseSchema
>;

export const WorkloadIdentityTokenErrorCodeSchema = z.enum([
  "invalid_request",
  "invalid_grant",
  "unsupported_grant_type",
  "rate_limited",
  "server_error",
]);
export type WorkloadIdentityTokenErrorCode = z.infer<
  typeof WorkloadIdentityTokenErrorCodeSchema
>;

export const WorkloadIdentityTokenErrorSchema = z.object({
  error: WorkloadIdentityTokenErrorCodeSchema,
  error_description: z.string(),
});
export type WorkloadIdentityTokenError = z.infer<
  typeof WorkloadIdentityTokenErrorSchema
>;

// === Internal helpers

function isHttpsIssuer(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    // `new URL` accepts "https://host?" with an empty search; the raw string
    // must not carry one either, or it would never equal a token's `iss`.
    !value.includes("?") &&
    !value.includes("#")
  );
}
