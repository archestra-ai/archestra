import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { openappaHelperBridge } from "@/openappa/helper-bridge";
import { openappaEnabled } from "@/openappa/service";
import { OPENAPPA_HELPERS_PREFIX } from "@/routes/route-paths";
import { ApiError, constructResponseSchema } from "@/types";
import { isLoopbackRequest } from "@/utils/network";

const HelperParamsSchema = z.object({
  installId: z.uuid(),
  externalName: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/),
});
const ConsultSchema = z.record(z.string(), z.unknown());

/**
 * The battery helper bridge the APPA runtime consults in place of a battery's
 * local command. Exempt from session authentication: the runtime runs in this
 * process and presents the per-process bridge bearer over loopback.
 */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    `${OPENAPPA_HELPERS_PREFIX}/:installId/:externalName`,
    {
      schema: {
        operationId: RouteId.ConsultOpenappaBatteryHelper,
        tags: ["OpenAPPA"],
        params: HelperParamsSchema,
        body: ConsultSchema,
        response: constructResponseSchema(ConsultSchema),
      },
    },
    async (request) => {
      if (!openappaEnabled())
        throw new ApiError(404, "Guardrails v2 is disabled");
      if (
        !openappaHelperBridge.presentsBridgeToken(request.headers.authorization)
      )
        throw new ApiError(401, "Unauthorized");
      if (!isLoopbackRequest(request.raw))
        throw new ApiError(
          403,
          "The helper bridge serves the local runtime only",
        );
      const outcome = await openappaHelperBridge.consult({
        installId: request.params.installId,
        externalName: request.params.externalName,
        request: JSON.stringify(request.body),
      });
      switch (outcome.kind) {
        case "answered":
          return outcome.answer;
        case "not_found":
          throw new ApiError(404, "Battery helper not found");
        case "failed":
          throw new ApiError(502, `Battery helper failed: ${outcome.reason}`);
        case "timed_out":
          throw new ApiError(504, "Battery helper timed out");
        case "busy":
          throw new ApiError(503, "Too many battery helper consults in flight");
      }
    },
  );
};
export default routes;
