import type { Action, Resource } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { userHasPermission } from "@/auth/utils";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { createFastifyInstance } from "@/server";
import { ApiError, type User } from "@/types";
import githubPatRoutes from "./github-pat.routes";

/**
 * Test app with real DB-backed RBAC (the endpoint permission map is enforced
 * against the user's role, not mocked) and the audit hook, matching the
 * github-app-config test harness.
 */
export async function buildGithubPatTestApp(
  user: User,
  organizationId: string,
) {
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    (request as typeof request & { user: unknown }).user = user;
    (request as typeof request & { organizationId: string }).organizationId =
      organizationId;

    const routeId = request.routeOptions.schema?.operationId;
    const required = routeId
      ? requiredEndpointPermissionsMap[
          routeId as keyof typeof requiredEndpointPermissionsMap
        ]
      : undefined;
    if (!required) return;
    for (const [resource, actions] of Object.entries(required)) {
      for (const action of (actions ?? []) as Action[]) {
        const allowed = await userHasPermission(
          user.id,
          organizationId,
          resource as Resource,
          action,
        );
        if (!allowed) throw new ApiError(403, "Forbidden");
      }
    }
  });
  registerAuditLogHook(app);
  await app.register(githubPatRoutes);
  return app;
}

export async function settleAuditWrites() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
