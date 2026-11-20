// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database/schema";
import {
  CreateServiceAccountFederatedCredentialBodySchema,
  FederatedCredentialClaimConditionsSchema,
  UpdateServiceAccountFederatedCredentialBodySchema,
} from "./service-account-federated-credential";

/*
 * An OAuth client's federated credentials take exactly the fields, and the
 * validation, of a service account's: only what they belong to differs.
 */

export const SelectOauthClientFederatedCredentialSchema = createSelectSchema(
  schema.oauthClientFederatedCredentialsTable,
  { claimConditions: FederatedCredentialClaimConditionsSchema },
);
export type SelectOauthClientFederatedCredential = z.infer<
  typeof SelectOauthClientFederatedCredentialSchema
>;

export const OauthClientFederatedCredentialResponseSchema =
  SelectOauthClientFederatedCredentialSchema.pick({
    id: true,
    oauthClientId: true,
    name: true,
    issuer: true,
    audience: true,
    subject: true,
    claimConditions: true,
    lastUsedAt: true,
    createdAt: true,
    updatedAt: true,
  });
export type OauthClientFederatedCredentialResponse = z.infer<
  typeof OauthClientFederatedCredentialResponseSchema
>;

export const CreateOauthClientFederatedCredentialBodySchema =
  CreateServiceAccountFederatedCredentialBodySchema;
export const UpdateOauthClientFederatedCredentialBodySchema =
  UpdateServiceAccountFederatedCredentialBodySchema;
export type UpdateOauthClientFederatedCredentialBody = z.infer<
  typeof UpdateOauthClientFederatedCredentialBodySchema
>;

export const OauthClientFederatedCredentialParamsSchema = z.object({
  id: z.string(),
  credentialId: z.string().uuid(),
});

/** RFC 7523: a JWT presented as the client's authentication. */
export const JWT_BEARER_CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
