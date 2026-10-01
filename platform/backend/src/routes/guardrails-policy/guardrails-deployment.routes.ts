import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getGuardrailsDeployment,
  setGuardrailsDeployment,
} from "@/services/guardrails-deployment";
import { constructResponseSchema } from "@/types";
import { UnsupportedAppaClientActionSchema } from "@/types/guardrails-policy";

const status = z.object({
  enabled: z.boolean(),
  unsupportedClientAction: UnsupportedAppaClientActionSchema,
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
          })
          .refine(
            (body) =>
              body.enabled !== undefined ||
              body.unsupportedClientAction !== undefined,
            "Set at least one guardrails deployment setting",
          ),
        response: constructResponseSchema(status),
      },
    },
    async (request) => {
      return setGuardrailsDeployment(request.body);
    },
  );
};
export default routes;
