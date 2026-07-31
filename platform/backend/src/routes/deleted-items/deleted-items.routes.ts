import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { DeletedItemModel } from "@/models";
import { restoreDeletedItem } from "@/services/deleted-items-restore";
import { purgeDeletedItem } from "@/services/soft-delete-purge";
import {
  ApiError,
  constructResponseSchema,
  DeletedItemEntityTypeSchema,
  DeletedItemSchema,
} from "@/types";

/**
 * Deleted Items: the organization-wide trash.
 *
 * One set of endpoints over every soft-deletable entity rather than a trash view
 * per resource, so an admin has a single place to see what is recoverable and
 * how long it has left. `entityType` is a parameter rather than a path segment
 * for the same reason — an entity that starts soft-deleting later joins by
 * appearing in the registry, with no new routes.
 *
 * All three endpoints are gated on `organizationSettings` (read to list, update
 * to act) because they cross ownership boundaries: this lists every member's
 * deleted rows, and restore and permanent delete act on rows the caller does not
 * own. See the entries in `shared/access-control.ts`.
 */
const deletedItemsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/deleted-items",
    {
      schema: {
        operationId: RouteId.ListDeletedItems,
        description:
          "List the organization's soft-deleted entities, newest deletion first",
        tags: ["Deleted Items"],
        querystring: PaginationQuerySchema.extend({
          entityTypes: z
            .union([
              DeletedItemEntityTypeSchema,
              z.array(DeletedItemEntityTypeSchema),
            ])
            .optional()
            .describe("Restrict the listing to these entity types"),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(DeletedItemSchema),
        ),
      },
    },
    async ({ organizationId, query }, reply) => {
      const entityTypes = query.entityTypes
        ? [query.entityTypes].flat()
        : undefined;

      const [data, total] = await Promise.all([
        DeletedItemModel.listForOrganization({
          organizationId,
          entityTypes,
          limit: query.limit,
          offset: query.offset,
        }),
        DeletedItemModel.countForOrganization({ organizationId, entityTypes }),
      ]);

      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, query),
      });
    },
  );

  fastify.post(
    "/api/deleted-items/:entityType/:id/restore",
    {
      schema: {
        operationId: RouteId.RestoreDeletedItem,
        description: "Restore a soft-deleted entity from Deleted Items",
        tags: ["Deleted Items"],
        params: z.object({
          entityType: DeletedItemEntityTypeSchema,
          id: z.string(),
        }),
        response: constructResponseSchema(DeletedItemSchema.pick({ id: true })),
      },
    },
    async ({ params, organizationId }, reply) => {
      const item = await DeletedItemModel.findOne({
        entityType: params.entityType,
        id: params.id,
        organizationId,
      });
      if (!item) {
        throw new ApiError(404, "Deleted item not found");
      }

      const result = await restoreDeletedItem({ item, organizationId });

      switch (result.status) {
        case "restored":
          return reply.send({ id: item.id });
        case "conflict":
          throw new ApiError(409, result.message);
        case "unsupported":
          throw new ApiError(400, result.message);
        case "not_found":
          throw new ApiError(404, "Deleted item not found");
      }
    },
  );

  fastify.delete(
    "/api/deleted-items/:entityType/:id",
    {
      schema: {
        operationId: RouteId.PurgeDeletedItem,
        description:
          "Permanently delete a soft-deleted entity, reclaiming its rows and stored files",
        tags: ["Deleted Items"],
        params: z.object({
          entityType: DeletedItemEntityTypeSchema,
          id: z.string(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      const item = await DeletedItemModel.findOne({
        entityType: params.entityType,
        id: params.id,
        organizationId,
      });
      if (!item) {
        throw new ApiError(404, "Deleted item not found");
      }

      const outcome = await purgeDeletedItem({
        item,
        organizationId,
        actor: {
          type: "user",
          id: user.id,
          name: user.name ?? null,
          email: user.email ?? null,
        },
      });

      if (outcome.status === "deferred") {
        // The entity has more history attached than one request should rewrite
        // inline. Nothing was destroyed, and the nightly sweep resumes it.
        throw new ApiError(
          503,
          "This item has too much history to delete in one request. Its cleanup has started and will finish in the background.",
        );
      }

      // A "skipped" purge means the row was restored or already gone. Reporting
      // success matches DELETE's idempotent contract: the caller asked for it to
      // not exist as a deleted item, and it does not.
      return reply.send({ success: true });
    },
  );
};

export default deletedItemsRoutes;
