import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { openappaRemediesService } from "@/openappa/remedies";
import { openappaEnabled } from "@/openappa/service";
import { ApiError, constructResponseSchema } from "@/types";
import { RemediesViewSchema } from "@/types/openappa-remedies";

/** A read-only view of the policy; it changes nothing, so it produces no audit record. */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", async () => {
    if (!openappaEnabled())
      throw new ApiError(404, "Guardrails v2 is disabled");
  });
  app.get(
    "/api/openappa/remedies",
    {
      schema: {
        operationId: RouteId.GetOpenappaRemedies,
        description:
          "The authorities and sanitizers the policy and its included batteries declare, who runs each, what it may lift, and which kinds of block the rules can cause that no wired remedy lifts. `lastConsult` is filled only for a caller with `openappaDiagnostics:admin`.",
        tags: ["OpenAPPA"],
        response: constructResponseSchema(RemediesViewSchema),
      },
    },
    async (request) =>
      openappaRemediesService.view({
        organizationId: request.organizationId,
        userId: request.user.id,
      }),
  );
};

export default routes;
