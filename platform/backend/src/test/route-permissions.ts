import type { RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { hasPermission } from "@/auth";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { ApiError } from "@/types";

/** Exercise the real authorization step in route tests that supply a user directly. */
export function registerRoutePermissions(app: FastifyInstanceWithZod) {
  app.addHook("preHandler", async (request) => {
    const operation = request.routeOptions.schema?.operationId as RouteId;
    const required = requiredEndpointPermissionsMap[operation];
    if (!required) throw new ApiError(403, "Unknown route");
    const { success } = await hasPermission(
      required,
      request.headers,
      undefined,
      {
        userId: request.user.id,
        organizationId: request.organizationId,
      },
    );
    if (!success) throw new ApiError(403, "Forbidden");
  });
}
