import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { openappaArchestraAnnotator } from "@/openappa/archestra-annotator";
import { openappaDeclarations } from "@/openappa/declarations";
import { openappaEnabled } from "@/openappa/service";
import { OPENAPPA_ARCHESTRA_ANNOTATOR_PATH } from "@/routes/route-paths";
import { ApiError, constructResponseSchema } from "@/types";
import { isLoopbackRequest } from "@/utils/network";

const AnnotationRequestSchema = z.object({
  system: z.string(),
  input: z.string(),
  schema: z.record(z.string(), z.unknown()),
});
const AnswerSchema = z.record(z.string(), z.unknown());

/**
 * The runtime's `builtin = "archestra"` annotator posts its rendered prompt
 * here and gets the model's answer object back as the body. Exempt from
 * session authentication: the runtime runs in this process and presents the
 * per-process bridge bearer over loopback, checked in the same order as the
 * helper bridge.
 */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    OPENAPPA_ARCHESTRA_ANNOTATOR_PATH,
    {
      schema: {
        operationId: RouteId.AnnotateOpenappaToolWithArchestra,
        tags: ["OpenAPPA"],
        body: AnnotationRequestSchema,
        response: constructResponseSchema(AnswerSchema),
      },
      onRequest: async (request) => {
        if (!openappaEnabled())
          throw new ApiError(404, "Guardrails v2 is disabled");
        if (!isLoopbackRequest(request.raw))
          throw new ApiError(
            403,
            "The archestra annotator serves the local runtime only",
          );
        if (
          !openappaDeclarations.presentsBridgeToken(
            request.headers.authorization,
          )
        )
          throw new ApiError(401, "Unauthorized");
      },
    },
    async (request) => {
      const outcome = await openappaArchestraAnnotator.annotate(request.body);
      switch (outcome.kind) {
        case "answered":
          return outcome.answer;
        // A 4xx the runtime does not retry: the deployment has to change first.
        case "unconfigured":
          throw new ApiError(409, outcome.reason);
        case "throttled":
          throw new ApiError(429, "The LLM call was rate-limited");
        case "failed":
          throw new ApiError(502, outcome.reason);
      }
    },
  );
};
export default routes;
