import { type Action, type Resource, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import { blobProviderService } from "@/services/blob-provider";
import {
  ApiError,
  BlobProviderTestResultSchema,
  CreateBlobProviderRequestSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  PublicBlobProviderSchema,
  UpdateBlobProviderRequestSchema,
  UuidIdSchema,
} from "@/types";

/**
 * Organization blob providers: object storage destinations that features
 * write files to (cost exports today). Credentials are write-only.
 */
const blobProviderRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/blob-providers",
    {
      schema: {
        operationId: RouteId.ListBlobProviders,
        description:
          "List the organization's blob providers. Credentials are never returned.",
        tags: ["Blob Providers"],
        response: constructResponseSchema(z.array(PublicBlobProviderSchema)),
      },
    },
    async ({ organizationId, user }, reply) => {
      // Whoever schedules cost exports picks their destination here, without
      // needing the rest of the organization settings.
      const allowed = await anyPermission({
        userId: user.id,
        organizationId,
        anyOf: [
          ["organizationSettings", "read"],
          ["costExport", "create"],
          ["costExport", "update"],
        ],
      });
      if (!allowed) throw new ApiError(403, "Forbidden");
      return reply.send(await blobProviderService.list(organizationId));
    },
  );

  fastify.post(
    "/api/blob-providers",
    {
      schema: {
        operationId: RouteId.CreateBlobProvider,
        description:
          "Configure a blob provider. Credentials are stored in the secrets manager.",
        tags: ["Blob Providers"],
        body: CreateBlobProviderRequestSchema,
        response: constructResponseSchema(PublicBlobProviderSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      return reply.send(
        await blobProviderService.create({ organizationId, data: body }),
      );
    },
  );

  fastify.put(
    "/api/blob-providers/:id",
    {
      schema: {
        operationId: RouteId.UpdateBlobProvider,
        description:
          "Update a blob provider. Send credentials only to replace them.",
        tags: ["Blob Providers"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateBlobProviderRequestSchema,
        response: constructResponseSchema(PublicBlobProviderSchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      return reply.send(
        await blobProviderService.update({
          id: params.id,
          organizationId,
          data: body,
        }),
      );
    },
  );

  fastify.delete(
    "/api/blob-providers/:id",
    {
      schema: {
        operationId: RouteId.DeleteBlobProvider,
        description:
          "Delete a blob provider and its credentials. Rejected while a cost export writes to it.",
        tags: ["Blob Providers"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      await blobProviderService.delete({ id: params.id, organizationId });
      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/blob-providers/:id/test",
    {
      schema: {
        operationId: RouteId.TestBlobProvider,
        description:
          "Check a blob provider by writing and deleting a small test object under its prefix.",
        tags: ["Blob Providers"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(BlobProviderTestResultSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      return reply.send(
        await blobProviderService.test({ id: params.id, organizationId }),
      );
    },
  );
};

export default blobProviderRoutes;

// === internal ===

async function anyPermission(params: {
  userId: string;
  organizationId: string;
  anyOf: [Resource, Action][];
}): Promise<boolean> {
  for (const [resource, action] of params.anyOf) {
    if (
      await userHasPermission(
        params.userId,
        params.organizationId,
        resource,
        action,
      )
    ) {
      return true;
    }
  }
  return false;
}
