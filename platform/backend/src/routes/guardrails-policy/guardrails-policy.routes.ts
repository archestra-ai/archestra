import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { openappaBatteriesService } from "@/openappa/batteries";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { constructResponseSchema } from "@/types";
import {
  GuardrailsPolicySchema,
  GuardrailsValidationSchema,
  UpdateGuardrailsPolicySchema,
  ValidateGuardrailsPolicySchema,
} from "@/types/guardrails-policy";
import noopAnnotatorRoutes from "./guardrails-noop-annotator.routes";

const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(noopAnnotatorRoutes);
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
