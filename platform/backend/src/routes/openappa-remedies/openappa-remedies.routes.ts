import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { openappaRemediesService } from "@/openappa/remedies";
import { openappaEnabled } from "@/openappa/service";
import { ApiError, constructResponseSchema } from "@/types";
import {
  RemediesActivitySchema,
  RemediesViewSchema,
} from "@/types/openappa-remedies";

const TIME_ZONES = new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);

/** A read-only view of the policy; it changes nothing, so it produces no audit record. */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", async () => {
    if (!openappaEnabled())
      throw new ApiError(404, "Guardrails v2 is disabled");
  });
  app.get(
    "/api/openappa/remedies",
    {
      schema: {
        operationId: RouteId.GetOpenappaRemedies,
        description:
          "The authorities and sanitizers the policy and its included batteries declare, who runs each, what it may lift, and which kinds of block the rules can cause that no wired remedy lifts. `lastConsult` is filled only for a caller with `openappaDiagnostics:admin`.",
        tags: ["OpenAPPA"],
        response: constructResponseSchema(RemediesViewSchema),
      },
    },
    async (request) =>
      openappaRemediesService.view({
        organizationId: request.organizationId,
        userId: request.user.id,
      }),
  );
  app.get(
    "/api/openappa/remedies/activity",
    {
      schema: {
        operationId: RouteId.GetOpenappaRemediesActivity,
        description:
          "What authorities and sanitizers answered on each of the last seven days: reviews approved and denied, and results or arguments cleaned. Days are calendar days in `timeZone`.",
        tags: ["OpenAPPA"],
        querystring: z.object({
          timeZone: z
            .string()
            .refine((zone) => TIME_ZONES.has(zone), "Unknown time zone")
            .default("UTC"),
        }),
        response: constructResponseSchema(RemediesActivitySchema),
      },
    },
    async (request) =>
      openappaRemediesService.activity({
        organizationId: request.organizationId,
        timeZone: request.query.timeZone,
      }),
  );
};

export default routes;
