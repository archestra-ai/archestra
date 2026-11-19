// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireOauthClientAccess } from "@/auth/oauth-client-permissions";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import OauthClientFederatedCredentialModel from "@/models/oauth-client-federated-credential";
import { assertPublicIssuer } from "@/services/workload-identity/federated-token";
import { ApiError, constructResponseSchema } from "@/types";
import {
  CreateOauthClientFederatedCredentialBodySchema,
  OauthClientFederatedCredentialParamsSchema,
  OauthClientFederatedCredentialResponseSchema,
  UpdateOauthClientFederatedCredentialBodySchema,
} from "@/types/oauth-client-federated-credential";

const BASE_PATH = "/api/oauth-clients/:id/federated-credentials";
const TAGS = ["OAuth Clients"];

/**
 * Federated credentials of an OAuth client: trust policies that let a
 * workload authenticate as the client with its own OIDC token, sent as the
 * client assertion of a client credentials grant, instead of the client
 * secret. Reading them takes read on the client; changing them takes update,
 * as rotating its secret does, since each one lets someone else sign in as
 * the client.
 */
const oauthClientFederatedCredentialRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
  fastify.get(
    BASE_PATH,
    {
      schema: {
        operationId: RouteId.GetOauthClientFederatedCredentials,
        description:
          "List an OAuth client's federated credentials: the OIDC issuers, audiences, subjects and claims whose tokens authenticate as the client",
        tags: TAGS,
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(
          OauthClientFederatedCredentialResponseSchema.array(),
        ),
      },
    },
    async (request, reply) => {
      await requireOauthClientAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        resource: "oauthClient",
        id: request.params.id,
        action: "read",
      });
      return reply.send(
        await OauthClientFederatedCredentialModel.listForOauthClient({
          oauthClientId: request.params.id,
          organizationId: request.organizationId,
        }),
      );
    },
  );

  fastify.post(
    BASE_PATH,
    {
      schema: {
        operationId: RouteId.CreateOauthClientFederatedCredential,
        description:
          "Add a federated credential to an OAuth client that signs in as itself. A token from the issuer whose audience, subject and listed claims all match exactly can then be sent as the client_assertion of a client credentials grant at /api/auth/oauth2/token.",
        tags: TAGS,
        params: z.object({ id: z.string() }),
        body: CreateOauthClientFederatedCredentialBodySchema,
        response: constructResponseSchema(
          OauthClientFederatedCredentialResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      const oauthClientId = request.params.id;
      await requireOauthClientAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        resource: "oauthClient",
        id: oauthClientId,
        action: "update",
      });
      const client = await ManagedOauthClientModel.findById({
        id: oauthClientId,
        organizationId: request.organizationId,
      });
      if (!client) throw new ApiError(404, "OAuth client not found");
      if (client.grantType !== "client_credentials")
        throw new ApiError(
          400,
          "Only an OAuth client that signs in as itself can have federated credentials",
        );
      assertPublicIssuer(request.body.issuer);
      if (
        (await OauthClientFederatedCredentialModel.countForOauthClient(
          oauthClientId,
        )) >= OauthClientFederatedCredentialModel.MAX_PER_OAUTH_CLIENT
      )
        throw new ApiError(
          400,
          `An OAuth client can have at most ${OauthClientFederatedCredentialModel.MAX_PER_OAUTH_CLIENT} federated credentials`,
        );
      await assertNameFree({ oauthClientId, name: request.body.name });

      const created = await OauthClientFederatedCredentialModel.create({
        organizationId: request.organizationId,
        oauthClientId,
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
        operationId: RouteId.UpdateOauthClientFederatedCredential,
        description:
          "Update an OAuth client's federated credential. Changing its issuer, audience, subject or claims revokes the access tokens it already issued.",
        tags: TAGS,
        params: OauthClientFederatedCredentialParamsSchema,
        body: UpdateOauthClientFederatedCredentialBodySchema,
        response: constructResponseSchema(
          OauthClientFederatedCredentialResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      const { id: oauthClientId, credentialId } = request.params;
      await requireOauthClientAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        resource: "oauthClient",
        id: oauthClientId,
        action: "update",
      });
      if (request.body.issuer) assertPublicIssuer(request.body.issuer);
      if (request.body.name)
        await assertNameFree({
          oauthClientId,
          name: request.body.name,
          excludeId: credentialId,
        });

      const updated = await OauthClientFederatedCredentialModel.update({
        id: credentialId,
        oauthClientId,
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
        operationId: RouteId.DeleteOauthClientFederatedCredential,
        description:
          "Delete an OAuth client's federated credential. Access tokens it issued stop working at once.",
        tags: TAGS,
        params: OauthClientFederatedCredentialParamsSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      const { id: oauthClientId, credentialId } = request.params;
      await requireOauthClientAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        resource: "oauthClient",
        id: oauthClientId,
        action: "update",
      });
      const success = await OauthClientFederatedCredentialModel.delete({
        id: credentialId,
        oauthClientId,
        organizationId: request.organizationId,
      });
      if (!success) throw new ApiError(404, "Federated credential not found");
      return reply.send({ success });
    },
  );
};

export default oauthClientFederatedCredentialRoutes;

// === Internal helpers

async function assertNameFree(params: {
  oauthClientId: string;
  name: string;
  excludeId?: string;
}): Promise<void> {
  if (await OauthClientFederatedCredentialModel.isNameTaken(params))
    throw new ApiError(
      409,
      "This OAuth client already has a federated credential with that name",
    );
}
