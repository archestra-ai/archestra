// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { z } from "zod";
import { CreateServiceAccountBodySchema } from "./service-account";
import { CreateServiceAccountFederatedCredentialBodySchema } from "./service-account-federated-credential";

/**
 * Service accounts declared in `ARCHESTRA_AUTH_SERVICE_ACCOUNT_BOOTSTRAP` (the Helm
 * chart's `archestra.bootstrap.serviceAccounts`). A fixed `id` lets a
 * workload be configured with the account before Archestra first starts.
 */
export const ServiceAccountBootstrapSchema = z.array(
  CreateServiceAccountBodySchema.pick({
    name: true,
    description: true,
  })
    .extend({
      id: z.uuid().optional(),
      /**
       * Role identifiers the account holds together: predefined roles
       * (`member`), fixed roles (`fixed:agents:reader`) or custom role
       * identifiers.
       */
      roles: z
        .array(
          z
            .string()
            .trim()
            .min(1)
            .max(256)
            .refine((role) => !role.includes(","), {
              message: "A role identifier cannot contain a comma",
            }),
        )
        .min(1)
        .max(50),
      federatedCredentials: z
        .array(CreateServiceAccountFederatedCredentialBodySchema)
        .max(20)
        .default([]),
    })
    .strict(),
);
export type ServiceAccountBootstrap = z.infer<
  typeof ServiceAccountBootstrapSchema
>;
