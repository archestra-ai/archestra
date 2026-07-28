import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getPermissionsForUserContext } from "@/auth/utils";
import OrganizationRoleModel from "@/models/organization-role";
import ServiceAccountModel from "@/models/service-account";
import {
  ApiError,
  CreateServiceAccountBodySchema,
  CreateServiceAccountTokenBodySchema,
  constructResponseSchema,
  DeleteServiceAccountResponseSchema,
  ServiceAccountDetailResponseSchema,
  ServiceAccountIdParamsSchema,
  ServiceAccountResponseSchema,
  ServiceAccountTokenIdParamsSchema,
  ServiceAccountTokenResponseSchema,
  ServiceAccountTokenWithValueResponseSchema,
  UpdateServiceAccountBodySchema,
  UpdateServiceAccountTokenBodySchema,
} from "@/types";

const serviceAccountRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/service-accounts",
    {
      schema: {
        operationId: RouteId.GetServiceAccounts,
        description: "List organization service accounts",
        tags: ["Service Accounts"],
        response: constructResponseSchema(ServiceAccountResponseSchema.array()),
      },
    },
    async (request, reply) => {
      const serviceAccounts = await ServiceAccountModel.listByOrganizationId(
        request.organizationId,
      );
      return reply.send(serviceAccounts);
    },
  );

  fastify.get(
    "/api/service-accounts/:id",
    {
      schema: {
        operationId: RouteId.GetServiceAccount,
        description: "Get one organization service account",
        tags: ["Service Accounts"],
        params: ServiceAccountIdParamsSchema,
        response: constructResponseSchema(ServiceAccountDetailResponseSchema),
      },
    },
    async (request, reply) => {
      const serviceAccount = await ServiceAccountModel.findById(
        request.params.id,
        request.organizationId,
      );
      if (!serviceAccount) {
        throw new ApiError(404, "Service account not found");
      }

      return reply.send(serviceAccount);
    },
  );

  fastify.post(
    "/api/service-accounts",
    {
      schema: {
        operationId: RouteId.CreateServiceAccount,
        description: "Create an organization service account",
        tags: ["Service Accounts"],
        body: CreateServiceAccountBodySchema,
        response: constructResponseSchema(ServiceAccountDetailResponseSchema),
      },
    },
    async (request, reply) => {
      await validateRoleOrThrow({
        role: request.body.role,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      const serviceAccount = await ServiceAccountModel.create({
        organizationId: request.organizationId,
        name: request.body.name,
        role: request.body.role,
      });

      return reply.send(serviceAccount);
    },
  );

  fastify.patch(
    "/api/service-accounts/:id",
    {
      schema: {
        operationId: RouteId.UpdateServiceAccount,
        description: "Update an organization service account",
        tags: ["Service Accounts"],
        params: ServiceAccountIdParamsSchema,
        body: UpdateServiceAccountBodySchema,
        response: constructResponseSchema(ServiceAccountDetailResponseSchema),
      },
    },
    async (request, reply) => {
      if (request.body.role) {
        await validateRoleOrThrow({
          role: request.body.role,
          organizationId: request.organizationId,
          userId: request.user.id,
        });
      }

      const serviceAccount = await ServiceAccountModel.update(
        request.params.id,
        request.organizationId,
        request.body,
      );
      if (!serviceAccount) {
        throw new ApiError(404, "Service account not found");
      }

      return reply.send(serviceAccount);
    },
  );

  fastify.delete(
    "/api/service-accounts/:id",
    {
      schema: {
        operationId: RouteId.DeleteServiceAccount,
        description: "Delete an organization service account",
        tags: ["Service Accounts"],
        params: ServiceAccountIdParamsSchema,
        response: constructResponseSchema(DeleteServiceAccountResponseSchema),
      },
    },
    async (request, reply) => {
      const success = await ServiceAccountModel.delete(
        request.params.id,
        request.organizationId,
      );
      if (!success) {
        throw new ApiError(404, "Service account not found");
      }

      return reply.send({ success });
    },
  );

  fastify.post(
    "/api/service-accounts/:id/tokens",
    {
      schema: {
        operationId: RouteId.CreateServiceAccountToken,
        description: "Create a token for an organization service account",
        tags: ["Service Accounts"],
        params: ServiceAccountIdParamsSchema,
        body: CreateServiceAccountTokenBodySchema,
        response: constructResponseSchema(
          ServiceAccountTokenWithValueResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      try {
        const token = await ServiceAccountModel.createToken({
          serviceAccountId: request.params.id,
          organizationId: request.organizationId,
          name: request.body.name,
          expiresIn: request.body.expiresIn,
        });

        return reply.send(token);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Service account token limit exceeded"
        ) {
          throw new ApiError(400, "Service account token limit exceeded");
        }
        if (
          error instanceof Error &&
          error.message === "Service account not found"
        ) {
          throw new ApiError(404, "Service account not found");
        }
        throw error;
      }
    },
  );

  fastify.delete(
    "/api/service-accounts/:id/tokens/:tokenId",
    {
      schema: {
        operationId: RouteId.DeleteServiceAccountToken,
        description: "Delete one service account token",
        tags: ["Service Accounts"],
        params: ServiceAccountTokenIdParamsSchema,
        response: constructResponseSchema(DeleteServiceAccountResponseSchema),
      },
    },
    async (request, reply) => {
      const success = await ServiceAccountModel.deleteToken({
        serviceAccountId: request.params.id,
        tokenId: request.params.tokenId,
        organizationId: request.organizationId,
      });
      if (!success) {
        throw new ApiError(404, "Service account token not found");
      }

      return reply.send({ success });
    },
  );

  fastify.patch(
    "/api/service-accounts/:id/tokens/:tokenId",
    {
      schema: {
        operationId: RouteId.UpdateServiceAccountToken,
        description: "Update one service account token",
        tags: ["Service Accounts"],
        params: ServiceAccountTokenIdParamsSchema,
        body: UpdateServiceAccountTokenBodySchema,
        response: constructResponseSchema(ServiceAccountTokenResponseSchema),
      },
    },
    async (request, reply) => {
      const token = await ServiceAccountModel.updateToken({
        serviceAccountId: request.params.id,
        tokenId: request.params.tokenId,
        organizationId: request.organizationId,
        data: request.body,
      });
      if (!token) {
        throw new ApiError(404, "Service account token not found");
      }

      return reply.send(token);
    },
  );
};

export default serviceAccountRoutes;

// === Internal helpers

/**
 * A service-account token authenticates with the full permission set of the
 * role stored on the account, so assigning a role is granting those
 * permissions to anyone holding a token. Existence alone is therefore not
 * enough to check: predefined roles resolve here too, so without the subset
 * rule below `serviceAccount:create` / `serviceAccount:update` would be enough
 * to mint a token that outranks the caller. The comparison uses the same
 * `validateRolePermissions` rule custom-role authoring uses, and resolves the
 * caller through `getPermissionsForUserContext` so a service-account caller is
 * measured against its own role rather than a synthetic user.
 */
async function validateRoleOrThrow(params: {
  role: string;
  organizationId: string;
  userId: string;
}) {
  const resolvedRole = await OrganizationRoleModel.getByIdentifier(
    params.role,
    params.organizationId,
  );
  if (!resolvedRole) {
    throw new ApiError(400, "Role not found");
  }

  const callerPermissions = await getPermissionsForUserContext({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  const { valid, missingPermissions } =
    OrganizationRoleModel.validateRolePermissions(
      callerPermissions,
      resolvedRole.permission,
    );
  if (!valid) {
    throw new ApiError(
      403,
      `You cannot grant permissions you don't have: ${missingPermissions.join(", ")}`,
    );
  }
}
