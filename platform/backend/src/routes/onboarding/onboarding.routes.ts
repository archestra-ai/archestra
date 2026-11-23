import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { UserOnboardingSeenItemModel } from "@/models";
import { constructResponseSchema } from "@/types";

const SeenNavItemsResponseSchema = z.object({
  items: z.array(z.string()),
});

const onboardingRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/onboarding/seen-nav-items",
    {
      schema: {
        operationId: RouteId.GetOnboardingSeenNavItems,
        description:
          "Get the onboarding nav items (red-dot nudges) the current user has already visited",
        tags: ["Onboarding"],
        response: constructResponseSchema(SeenNavItemsResponseSchema),
      },
    },
    async ({ user }, reply) => {
      const items = await UserOnboardingSeenItemModel.getSeenItems(user.id);
      return reply.send({ items });
    },
  );

  fastify.post(
    "/api/onboarding/seen-nav-items",
    {
      schema: {
        operationId: RouteId.MarkOnboardingNavItemsSeen,
        description:
          "Mark onboarding nav items (red-dot nudges) as visited for the current user; idempotent",
        tags: ["Onboarding"],
        body: z.object({
          items: z.array(z.string().min(1).max(128)).min(1).max(50),
        }),
        response: constructResponseSchema(SeenNavItemsResponseSchema),
      },
    },
    async ({ body, user }, reply) => {
      await UserOnboardingSeenItemModel.markSeen({
        userId: user.id,
        items: body.items,
      });
      const items = await UserOnboardingSeenItemModel.getSeenItems(user.id);
      return reply.send({ items });
    },
  );
};

export default onboardingRoutes;
