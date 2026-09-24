import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import {
  getGuardrailsDeployment,
  setGuardrailsDeployment,
} from "@/services/guardrails-deployment";
import { ApiError, constructResponseSchema } from "@/types";

const status = z.object({
  enabled: z.boolean(),
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
        body: z.object({ enabled: z.boolean() }),
        response: constructResponseSchema(status),
      },
    },
    async (request) => {
      if (
        !(await userHasPermission(
          request.user.id,
          request.organizationId,
          "organization",
          "update",
        ))
      )
        throw new ApiError(
          403,
          "Organization administration permission is required to manage deployment guardrails",
        );
      return setGuardrailsDeployment(request.body.enabled);
    },
  );
};
export default routes;
