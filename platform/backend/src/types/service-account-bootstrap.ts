// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { z } from "zod";
import { CreateServiceAccountBodySchema } from "./service-account";
import { CreateServiceAccountFederatedCredentialBodySchema } from "./service-account-federated-credential";

/**
 * Service accounts declared in `ARCHESTRA_SERVICE_ACCOUNT_BOOTSTRAP` (the Helm
 * chart's `archestra.bootstrap.serviceAccounts`). A fixed `id` lets a
 * workload be configured with the account before Archestra first starts.
 */
export const ServiceAccountBootstrapSchema = z.array(
  CreateServiceAccountBodySchema.pick({
    name: true,
    description: true,
    role: true,
  })
    .extend({
      id: z.uuid().optional(),
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
