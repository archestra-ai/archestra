import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getGuardrailsDeployment,
  setGuardrailsDeployment,
} from "@/services/guardrails-deployment";
import { constructResponseSchema } from "@/types";
import {
  NewSessionPolicySchema,
  UnsupportedAppaClientActionSchema,
} from "@/types/guardrails-policy";

const status = z.object({
  enabled: z.boolean(),
  unsupportedClientAction: UnsupportedAppaClientActionSchema,
  breakTheGlassEnabled: z.boolean(),
  newSessionPolicy: NewSessionPolicySchema,
  annotatorModelId: z.string().uuid().nullable(),
  annotatorLlmApiKeyId: z.string().uuid().nullable(),
  featureEnabled: z.boolean(),
  active: z.boolean(),
});
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/guardrails-deployment",
    {
      schema: {
        operationId: RouteId.GetGuardrailsDeployment,
        tags: ["Guardrails"],
        response: constructResponseSchema(status),
      },
    },
    getGuardrailsDeployment,
  );
  app.put(
    "/api/guardrails-deployment",
    {
      schema: {
        operationId: RouteId.UpdateGuardrailsDeployment,
        tags: ["Guardrails"],
        body: z
          .object({
            enabled: z.boolean().optional(),
            unsupportedClientAction:
              UnsupportedAppaClientActionSchema.optional(),
            breakTheGlassEnabled: z.boolean().optional(),
            newSessionPolicy: NewSessionPolicySchema.optional(),
            annotatorModelId: z.string().uuid().nullable().optional(),
            annotatorLlmApiKeyId: z.string().uuid().nullable().optional(),
          })
          .refine(
            (body) =>
              body.enabled !== undefined ||
              body.unsupportedClientAction !== undefined ||
              body.breakTheGlassEnabled !== undefined ||
              body.newSessionPolicy !== undefined ||
              body.annotatorModelId !== undefined ||
              body.annotatorLlmApiKeyId !== undefined,
            "Set at least one guardrails deployment setting",
          ),
        response: constructResponseSchema(status),
      },
    },
    async (request) => {
      return setGuardrailsDeployment(request.body, {
        userId: request.user.id,
        organizationId: request.organizationId,
      });
    },
  );
};
export default routes;
