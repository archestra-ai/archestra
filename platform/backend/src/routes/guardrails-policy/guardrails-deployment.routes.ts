import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getGuardrailsDeployment,
  setGuardrailsDeployment,
} from "@/services/guardrails-deployment";
import { constructResponseSchema } from "@/types";
import {
  EnforcedMarksSchema,
  GuardrailsModeSchema,
  HumanApprovalModeSchema,
  PersonApprovalSchema,
  UnapprovableBlockModeSchema,
  UnsupportedAppaClientActionSchema,
} from "@/types/guardrails-policy";

const status = z.object({
  mode: GuardrailsModeSchema,
  personApproval: PersonApprovalSchema,
  enforcedMarks: z.array(z.string()),
  /** Deprecated legacy settings below: derived from and written with the above. */
  enabled: z.boolean(),
  unsupportedClientAction: UnsupportedAppaClientActionSchema,
  breakTheGlassEnabled: z.boolean(),
  humanApprovalMode: HumanApprovalModeSchema,
  unapprovableBlockMode: UnapprovableBlockModeSchema,
  /** Settings an environment variable sets; the API refuses to change them. */
  environmentOverrides: z.array(
    z.object({
      setting: z.enum([
        "humanApprovalMode",
        "personApproval",
        "unapprovableBlockMode",
      ]),
      variable: z.string(),
    }),
  ),
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
          .strictObject({
            mode: GuardrailsModeSchema.optional(),
            personApproval: PersonApprovalSchema.optional(),
            enforcedMarks: EnforcedMarksSchema.optional(),
            enabled: z.boolean().optional(),
            unsupportedClientAction:
              UnsupportedAppaClientActionSchema.optional(),
            breakTheGlassEnabled: z.boolean().optional(),
            humanApprovalMode: HumanApprovalModeSchema.optional(),
            unapprovableBlockMode: UnapprovableBlockModeSchema.optional(),
            annotatorModelId: z.string().uuid().nullable().optional(),
            annotatorLlmApiKeyId: z.string().uuid().nullable().optional(),
          })
          .refine(
            (body) => Object.values(body).some((value) => value !== undefined),
            "Set at least one guardrails deployment setting",
          ),
        response: constructResponseSchema(
          status.extend({
            /** Why sessions these settings route to a line follow Enforce instead. */
            warnings: z.array(z.string()),
          }),
        ),
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
