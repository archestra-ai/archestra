import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { openappaBatteriesService } from "@/openappa/batteries";
import { GUARDRAILS_NOOP_ANNOTATOR_PATH } from "@/routes/route-paths";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { constructResponseSchema } from "@/types";
import {
  GuardrailsAnnotationRequestSchema,
  GuardrailsAnnotationSchema,
  GuardrailsPolicySchema,
  GuardrailsValidationSchema,
  UpdateGuardrailsPolicySchema,
  ValidateGuardrailsPolicySchema,
} from "@/types/guardrails-policy";

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
  app.get(
    "/api/guardrails-policy",
    {
      schema: {
        operationId: RouteId.GetGuardrailsPolicy,
        tags: ["Guardrails"],
        response: constructResponseSchema(GuardrailsPolicySchema),
      },
    },
    async (request) => guardrailsPolicyService.get(request.organizationId),
  );
  app.post(
    "/api/guardrails-policy/validate",
    {
      schema: {
        operationId: RouteId.ValidateGuardrailsPolicy,
        tags: ["Guardrails"],
        body: ValidateGuardrailsPolicySchema,
        response: constructResponseSchema(GuardrailsValidationSchema),
      },
    },
    async (request) =>
      guardrailsPolicyService.validate(request.body.content, {
        organizationId: request.organizationId,
      }),
  );
  app.put(
    "/api/guardrails-policy",
    {
      schema: {
        operationId: RouteId.UpdateGuardrailsPolicy,
        tags: ["Guardrails"],
        body: UpdateGuardrailsPolicySchema,
        response: constructResponseSchema(GuardrailsPolicySchema),
      },
    },
    async (request) => {
      const saved = await guardrailsPolicyService.update({
        ...request.body,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      await openappaBatteriesService.recompileOrganizations([
        request.organizationId,
      ]);
      return saved;
    },
  );
};
export default routes;
