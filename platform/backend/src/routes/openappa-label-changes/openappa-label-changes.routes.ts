import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { externalConsultAccess } from "@/services/openappa-external-consults";
import { listSessionLabelChanges } from "@/services/openappa-label-changes";
import { constructResponseSchema } from "@/types";
import { LabelChangeViewSchema } from "@/types/openappa-label-changes";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/openappa/label-changes",
    {
      schema: {
        operationId: RouteId.GetOpenappaLabelChanges,
        description:
          "The trust and audience label of an LLM session over time, oldest first: a `session_start` baseline, then one row per change, with the event that moved it and the rule the current policy applies to the tool. Viewers who may not read everyone's consults see only their own sessions.",
        tags: ["OpenAPPA"],
        querystring: z.object({
          llmSessionId: z
            .string()
            .min(1)
            .describe("An LLM session ID, as on the LLM logs page"),
        }),
        response: constructResponseSchema(
          z.object({ data: z.array(LabelChangeViewSchema) }),
        ),
      },
    },
    async ({ query, user, organizationId }, reply) => {
      const access = await externalConsultAccess({
        userId: user.id,
        organizationId,
      });
      const data = await listSessionLabelChanges({
        organizationId,
        llmSessionId: query.llmSessionId,
        callerId: access.callerId,
      });
      return reply.send({ data });
    },
  );
};

export default routes;
