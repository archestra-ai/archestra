// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import ServiceAccountFederatedCredentialModel from "@/models/service-account-federated-credential";
import { requireServiceAccountAccess } from "@/services/service-account-access";
import {
  ApiError,
  constructResponseSchema,
  DeleteServiceAccountResponseSchema,
  ServiceAccountIdParamsSchema,
} from "@/types";
import {
  CreateServiceAccountFederatedCredentialBodySchema,
  ServiceAccountFederatedCredentialParamsSchema,
  ServiceAccountFederatedCredentialResponseSchema,
  UpdateServiceAccountFederatedCredentialBodySchema,
} from "@/types/service-account-federated-credential";
import { isPrivateOrLoopbackHostname } from "@/utils/network";

const BASE_PATH = "/api/service-accounts/:id/federated-credentials";
const TAGS = ["Service Accounts"];

/**
 * Federated credentials: trust policies that let an external workload trade
 * its OIDC token for a short-lived token of the service account. Reading them
 * takes read on the account; changing them takes update, as minting a key
 * does, since each one lets someone else act as the account.
 */
const serviceAccountFederatedCredentialRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
  fastify.get(
    BASE_PATH,
    {
      schema: {
        operationId: RouteId.GetServiceAccountFederatedCredentials,
        description:
          "List a service account's federated credentials: the OIDC issuers, audiences, subjects and claims whose tokens can be exchanged for a short-lived token of the account",
        tags: TAGS,
        params: ServiceAccountIdParamsSchema,
        response: constructResponseSchema(
          ServiceAccountFederatedCredentialResponseSchema.array(),
        ),
      },
    },
    async (request, reply) => {
      await requireServiceAccountAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        id: request.params.id,
        action: "read",
      });
      return reply.send(
        await ServiceAccountFederatedCredentialModel.listForServiceAccount({
          serviceAccountId: request.params.id,
          organizationId: request.organizationId,
        }),
      );
    },
  );

  fastify.post(
    BASE_PATH,
    {
      schema: {
        operationId: RouteId.CreateServiceAccountFederatedCredential,
        description:
          "Add a federated credential to a service account. Tokens from the issuer whose audience, subject and listed claims all match exactly can then be exchanged at /api/workload-identity/token.",
        tags: TAGS,
        params: ServiceAccountIdParamsSchema,
        body: CreateServiceAccountFederatedCredentialBodySchema,
        response: constructResponseSchema(
          ServiceAccountFederatedCredentialResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      const serviceAccountId = request.params.id;
      await requireServiceAccountAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        id: serviceAccountId,
        action: "update",
      });
      assertPublicIssuer(request.body.issuer);
      if (
        (await ServiceAccountFederatedCredentialModel.countForServiceAccount(
          serviceAccountId,
        )) >= ServiceAccountFederatedCredentialModel.MAX_PER_SERVICE_ACCOUNT
      )
        throw new ApiError(
          400,
          `A service account can have at most ${ServiceAccountFederatedCredentialModel.MAX_PER_SERVICE_ACCOUNT} federated credentials`,
        );
      await assertNameFree({ serviceAccountId, name: request.body.name });

      const created = await ServiceAccountFederatedCredentialModel.create({
        organizationId: request.organizationId,
        serviceAccountId,
        name: request.body.name,
        issuer: request.body.issuer,
        audience: request.body.audience,
        subject: request.body.subject,
        claimConditions: request.body.claimConditions ?? {},
        createdBy: request.serviceAccount ? null : request.user.id,
      });
      return reply.send(created);
    },
  );

  fastify.patch(
    `${BASE_PATH}/:credentialId`,
    {
      schema: {
        operationId: RouteId.UpdateServiceAccountFederatedCredential,
        description:
          "Update a federated credential. Changing its issuer, audience, subject or claims revokes the tokens it already issued.",
        tags: TAGS,
        params: ServiceAccountFederatedCredentialParamsSchema,
        body: UpdateServiceAccountFederatedCredentialBodySchema,
        response: constructResponseSchema(
          ServiceAccountFederatedCredentialResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      const { id: serviceAccountId, credentialId } = request.params;
      await requireServiceAccountAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        id: serviceAccountId,
        action: "update",
      });
      if (request.body.issuer) assertPublicIssuer(request.body.issuer);
      if (request.body.name)
        await assertNameFree({
          serviceAccountId,
          name: request.body.name,
          excludeId: credentialId,
        });

      const updated = await ServiceAccountFederatedCredentialModel.update({
        id: credentialId,
        serviceAccountId,
        organizationId: request.organizationId,
        data: request.body,
      });
      if (!updated) throw new ApiError(404, "Federated credential not found");
      return reply.send(updated);
    },
  );

  fastify.delete(
    `${BASE_PATH}/:credentialId`,
    {
      schema: {
        operationId: RouteId.DeleteServiceAccountFederatedCredential,
        description:
          "Delete a federated credential. Tokens it issued stop working at once.",
        tags: TAGS,
        params: ServiceAccountFederatedCredentialParamsSchema,
        response: constructResponseSchema(DeleteServiceAccountResponseSchema),
      },
    },
    async (request, reply) => {
      const { id: serviceAccountId, credentialId } = request.params;
      await requireServiceAccountAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        id: serviceAccountId,
        action: "update",
      });
      const success = await ServiceAccountFederatedCredentialModel.delete({
        id: credentialId,
        serviceAccountId,
        organizationId: request.organizationId,
      });
      if (!success) throw new ApiError(404, "Federated credential not found");
      return reply.send({ success });
    },
  );
};

export default serviceAccountFederatedCredentialRoutes;

// === Internal helpers

/**
 * The server fetches the issuer's discovery document and keys, so an issuer
 * on a private or loopback address is refused here as well as at fetch time.
 */
function assertPublicIssuer(issuer: string): void {
  if (isPrivateOrLoopbackHostname(new URL(issuer).hostname))
    throw new ApiError(
      400,
      "The issuer must be publicly reachable: private and loopback addresses are refused",
    );
}

async function assertNameFree(params: {
  serviceAccountId: string;
  name: string;
  excludeId?: string;
}): Promise<void> {
  if (await ServiceAccountFederatedCredentialModel.isNameTaken(params))
    throw new ApiError(
      409,
      "This service account already has a federated credential with that name",
    );
}
