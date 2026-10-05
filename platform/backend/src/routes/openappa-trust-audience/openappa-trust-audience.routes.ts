import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { openappaEnabled } from "@/openappa/service";
import { openappaTrustAudienceService } from "@/openappa/trust-audience";
import { ApiError, constructResponseSchema } from "@/types";
import { TrustAudienceViewSchema } from "@/types/openappa-trust-audience";

/** A read-only view of the policy; it changes nothing, so it produces no audit record. */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", async () => {
    if (!openappaEnabled())
      throw new ApiError(404, "Guardrails v2 is disabled");
  });
  app.get(
    "/api/openappa/trust-audience",
    {
      schema: {
        operationId: RouteId.GetOpenappaTrustAudience,
        description:
          "The trust levels and audiences the policy works with, the audience sources included batteries declare, and the rules naming each audience. `lastConsult` is filled only for a caller with `openappaDiagnostics:admin`.",
        tags: ["OpenAPPA"],
        response: constructResponseSchema(TrustAudienceViewSchema),
      },
    },
    async (request) =>
      openappaTrustAudienceService.view({
        organizationId: request.organizationId,
        userId: request.user.id,
      }),
  );
};

export default routes;
