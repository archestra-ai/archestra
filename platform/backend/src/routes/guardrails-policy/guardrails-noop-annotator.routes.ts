import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { GUARDRAILS_NOOP_ANNOTATOR_PATH } from "@/routes/route-paths";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { constructResponseSchema } from "@/types";
import {
  GuardrailsAnnotationRequestSchema,
  GuardrailsAnnotationSchema,
} from "@/types/guardrails-policy";

/**
 * The `noop` annotator the APPA runtime posts to over loopback. Its own plugin
 * so worker processes can serve it without the policy editing routes.
 */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    GUARDRAILS_NOOP_ANNOTATOR_PATH,
    {
      schema: {
        operationId: RouteId.AnnotateGuardrailsTool,
        tags: ["Guardrails"],
        body: GuardrailsAnnotationRequestSchema,
        response: constructResponseSchema(GuardrailsAnnotationSchema),
      },
    },
    async () => guardrailsPolicyService.annotate(),
  );
};
export default routes;
