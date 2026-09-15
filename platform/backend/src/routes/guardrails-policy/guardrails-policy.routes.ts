import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { constructResponseSchema } from "@/types";
import {
  GuardrailsPolicySchema,
  GuardrailsValidationSchema,
  UpdateGuardrailsPolicySchema,
  ValidateGuardrailsPolicySchema,
} from "@/types/guardrails-policy";

const routes: FastifyPluginAsyncZod = async (app) => {
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
    async (request) => guardrailsPolicyService.validate(request.body.content),
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
    async (request) =>
      guardrailsPolicyService.update({
        ...request.body,
        organizationId: request.organizationId,
        userId: request.user.id,
      }),
  );
};
export default routes;
