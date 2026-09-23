import { randomUUID } from "node:crypto";
import {
  hasScopedPermission,
  parseLabelsParam,
  type ResourcePermissionAction,
  ResourcePermissionGrantSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getPermissionsForUserContext } from "@/auth/utils";
import { ServiceAccountLabelModel } from "@/models";
import OrganizationRoleModel from "@/models/organization-role";
import ServiceAccountModel from "@/models/service-account";
import { ResourcePermissions } from "@/services/resource-permissions";
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
import {
  BulkDeleteBodySchema,
  BulkIdsSchema,
  BulkOutcomeSchema,
  runBulk,
} from "./bulk-route";
import { registerEntityLabelRoutes } from "./entity-labels";

const serviceAccountRoutes: FastifyPluginAsyncZod = async (fastify) => {
  registerEntityLabelRoutes(fastify, {
    basePath: "/api/service-accounts",
    tag: "Service Accounts",
    entityNamePlural: "service accounts",
    model: ServiceAccountLabelModel,
    keysOperationId: RouteId.GetServiceAccountLabelKeys,
    valuesOperationId: RouteId.GetServiceAccountLabelValues,
  });

  fastify.get(
    "/api/service-accounts",
    {
      schema: {
        operationId: RouteId.GetServiceAccounts,
        description: "List organization service accounts",
        tags: ["Service Accounts"],
        querystring: z.object({
          labels: z
            .string()
            .optional()
            .describe(
              "Filter by labels. Format: key1:val1|val2;key2:val3. AND across keys, OR within values.",
            ),
        }),
        response: constructResponseSchema(ServiceAccountResponseSchema.array()),
      },
    },
    async (request, reply) => {
      const serviceAccounts = await ServiceAccountModel.listByOrganizationId(
        request.organizationId,
        parseLabelsParam(request.query.labels),
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        { userId: request.user.id },
        // SPDX-SnippetEnd
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
      await requireServiceAccountAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        id: request.params.id,
        action: "read",
      });
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
        body: CreateServiceAccountBodySchema.extend({
          initialGrants: z
            .array(ResourcePermissionGrantSchema)
            .max(200)
            .optional(),
        }),
        response: constructResponseSchema(ServiceAccountDetailResponseSchema),
      },
    },
    async (request, reply) => {
      await validateRoleOrThrow({
        role: request.body.role,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      if (request.body.initialGrants?.length) {
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        await ResourcePermissions.validateInitialGrants({
          organizationId: request.organizationId,
          userId: request.user.id,
          resource: "serviceAccount",
          grants: request.body.initialGrants,
          target: {
            id: randomUUID(),
            name: request.body.name,
            authorId: request.user.id,
            scope: "org",
            teams: [],
            users: [],
          },
        });
        // SPDX-SnippetEnd
      }
      const serviceAccount = await ServiceAccountModel.create({
        organizationId: request.organizationId,
        name: request.body.name,
        role: request.body.role,
        labels: request.body.labels,
        createdBy: request.user.id,
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        initialPermissionGrants: request.body.initialGrants,
        // SPDX-SnippetEnd
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
      await requireServiceAccountAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        id: request.params.id,
        action: "update",
      });
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

  fastify.patch(
    "/api/service-accounts/bulk",
    {
      schema: {
        operationId: RouteId.BulkSetServiceAccountsDisabled,
        description:
          "Enable or disable several service accounts in one request. A " +
          "disabled account authenticates with none of its keys, so this is " +
          "the reversible way to stop an automation without destroying the " +
          "keys it would need to start again. Ids outside the caller's " +
          "organization are reported in `failed` as not found and leave the " +
          "rest of the batch applied. An account already in the requested " +
          "state is reported as succeeded without being rewritten.",
        tags: ["Service Accounts"],
        body: z.object({ ids: BulkIdsSchema, disabled: z.boolean() }).strict(),
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId } = request;
      const { disabled } = request.body;

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: `service accounts bulk ${disabled ? "disable" : "enable"}`,
        notFoundMessage: "Service account not found",
        unexpectedMessage: `Could not ${disabled ? "disable" : "enable"} this service account`,
        load: async (ids) => {
          const wanted = new Set(ids);
          const accounts =
            await ServiceAccountModel.listByOrganizationId(organizationId);
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          // Checked per id rather than by filtering the query, so an account
          // the caller may not change is reported in `failed` while the
          // rest of the batch still applies.
          const reachable = await filterReachable({
            organizationId,
            userId: request.user.id,
            ids: accounts
              .filter((account) => wanted.has(account.id))
              .map((account) => account.id),
            action: "update",
          });
          // SPDX-SnippetEnd
          return new Map(
            accounts
              .filter((account) => reachable.has(account.id))
              .map((account) => [account.id, account]),
          );
        },
        describe: (account) => account.name,
        applyEach: async (account, id) => {
          if (account.disabled === disabled) return;
          const updated = await ServiceAccountModel.update(id, organizationId, {
            disabled,
          });
          if (!updated) {
            throw new ApiError(404, "Service account not found");
          }
        },
        audit: {
          target: request,
          snapshot: async (ids) => {
            const wanted = new Set(ids);
            const accounts =
              await ServiceAccountModel.listByOrganizationId(organizationId);
            return {
              serviceAccounts: accounts
                .filter((account) => wanted.has(account.id))
                .map(({ id, name, disabled: isDisabled }) => ({
                  id,
                  name,
                  disabled: isDisabled,
                }))
                // Sorted so an unchanged batch snapshots identically on both
                // sides and the audit diff stays empty.
                .sort((a, b) => a.id.localeCompare(b.id)),
            };
          },
        },
      });

      return reply.send(outcome);
    },
  );

  fastify.delete(
    "/api/service-accounts/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteServiceAccounts,
        description:
          "Delete several service accounts in one request, along with their " +
          "tokens. Ids outside the caller's organization are reported in " +
          "`failed` as not found and leave the rest of the batch applied.",
        tags: ["Service Accounts"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId } = request;

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "service accounts bulk delete",
        notFoundMessage: "Service account not found",
        unexpectedMessage: "Could not delete this service account",
        load: async (ids) => {
          const wanted = new Set(ids);
          const accounts =
            await ServiceAccountModel.listByOrganizationId(organizationId);
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          // Checked per id rather than by filtering the query, so an account
          // the caller may not delete is reported in `failed` while the
          // rest of the batch still applies.
          const reachable = await filterReachable({
            organizationId,
            userId: request.user.id,
            ids: accounts
              .filter((account) => wanted.has(account.id))
              .map((account) => account.id),
            action: "delete",
          });
          // SPDX-SnippetEnd
          return new Map(
            accounts
              .filter((account) => reachable.has(account.id))
              .map((account) => [account.id, account]),
          );
        },
        describe: (account) => account.name,
        applyEach: async (_account, id) => {
          const deleted = await ServiceAccountModel.delete(id, organizationId);
          if (!deleted) {
            throw new ApiError(404, "Service account not found");
          }
        },
        audit: {
          target: request,
          snapshot: async (ids) => {
            const wanted = new Set(ids);
            const accounts =
              await ServiceAccountModel.listByOrganizationId(organizationId);
            return {
              serviceAccounts: accounts
                .filter((account) => wanted.has(account.id))
                .map(({ id, name }) => ({ id, name }))
                // Sorted so an unchanged batch snapshots identically on both
                // sides and the audit diff stays empty.
                .sort((a, b) => a.id.localeCompare(b.id)),
            };
          },
        },
      });

      return reply.send(outcome);
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
      await requireServiceAccountAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        id: request.params.id,
        action: "delete",
      });
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
      await requireServiceAccountAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        id: request.params.id,
        action: "update",
      });
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
      await requireServiceAccountAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        id: request.params.id,
        action: "update",
      });
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
      await requireServiceAccountAccess({
        organizationId: request.organizationId,
        userId: request.user.id,
        id: request.params.id,
        action: "update",
      });
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

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Who may reach one service account.
 *
 * Reaching an account used to be a question about the caller alone: hold
 * `serviceAccount:read` and every account in the organization was yours to
 * list, rename or delete. There was no way to say "this person looks after
 * that one account", because an account was never something a grant could
 * point at. It is now, so the question is asked of the account.
 *
 * A missing account and a forbidden one answer the same way on purpose: which
 * of the two it is is itself something the caller is not entitled to know.
 */
async function requireServiceAccountAccess(params: {
  organizationId: string;
  userId: string;
  id: string;
  action: ResourcePermissionAction;
}): Promise<void> {
  if (!(await reaches(params)))
    throw new ApiError(404, "Service account not found");
}

/** The subset of a bulk batch this caller may act on. */
async function filterReachable(params: {
  organizationId: string;
  userId: string;
  ids: string[];
  action: ResourcePermissionAction;
}): Promise<Set<string>> {
  const verdicts = await Promise.all(
    params.ids.map(async (id) => ({
      id,
      allowed: await reaches({ ...params, id }),
    })),
  );
  return new Set(
    verdicts.filter((verdict) => verdict.allowed).map((verdict) => verdict.id),
  );
}

/**
 * One account, one action, answered for a converted deployment and an
 * unconverted one alike.
 *
 * `ResourcePermissions.allows` reads stored grants and nothing else, so on a
 * deployment whose policies have not been written yet it answers "no" to
 * everyone — administrators included. `getEffective` is the primitive that
 * knows the difference: with a migrated policy it resolves grants, and without
 * one it falls back to the role actions the grants were converted from. Only
 * the second answers correctly in both states, so the gate is built on it.
 */
async function reaches(params: {
  organizationId: string;
  userId: string;
  id: string;
  action: ResourcePermissionAction;
}): Promise<boolean> {
  const context = {
    organizationId: params.organizationId,
    userId: params.userId,
    resource: "serviceAccount" as const,
    scope: params.id,
  };
  try {
    const effective = await ResourcePermissions.getEffective(context);
    return hasScopedPermission({
      grants: effective.grants,
      required: { ...context, action: params.action },
    });
  } catch (error) {
    // A missing account answers the same way a refused one does: which of the
    // two it is is itself something the caller is not entitled to know.
    if (error instanceof ApiError && error.statusCode === 404) return false;
    throw error;
  }
}
// SPDX-SnippetEnd

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
  if (params.role.includes(",")) {
    for (const role of new Set(
      params.role.split(",").map((role) => role.trim()),
    )) {
      await validateRoleOrThrow({ ...params, role });
    }
    return;
  }
  const resolvedRole = await OrganizationRoleModel.getByIdentifier(
    params.role,
    params.organizationId,
  );
  if (!resolvedRole) {
    throw new ApiError(400, "Role not found");
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  await ResourcePermissions.validateSubjectAssignment({
    organizationId: params.organizationId,
    userId: params.userId,
    subjects: [{ type: "role", id: resolvedRole.id }],
  });
  // SPDX-SnippetEnd
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
