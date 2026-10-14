import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { BrowserStorageStateModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";

const SavedBrowserLoginSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  siteCount: z.number().int(),
  sizeBytes: z.number().int(),
  updatedAt: z.coerce.date(),
});

const browserStorageStatesRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/browser-storage-states",
    {
      schema: {
        operationId: RouteId.GetBrowserStorageStates,
        description:
          "List members whose Playwright browser logins are saved. Returns counts and sizes only, never cookies.",
        tags: ["Browser Storage States"],
        response: constructResponseSchema(z.array(SavedBrowserLoginSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(
        await BrowserStorageStateModel.listForOrganization(organizationId),
      );
    },
  );

  fastify.delete(
    "/api/browser-storage-states/:userId",
    {
      schema: {
        operationId: RouteId.DeleteBrowserStorageState,
        description:
          "Delete a member's saved Playwright browser logins, signing them out of every site in new chats",
        tags: ["Browser Storage States"],
        params: z.object({ userId: z.string().min(1) }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId }, reply) => {
      const deleted = await BrowserStorageStateModel.deleteForOrganization({
        userId: params.userId,
        organizationId,
      });
      if (!deleted) {
        throw new ApiError(404, "No saved browser logins for this user");
      }
      return reply.send({ success: true });
    },
  );
};

export default browserStorageStatesRoutes;
