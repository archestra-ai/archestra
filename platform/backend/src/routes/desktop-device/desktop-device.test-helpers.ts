import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import type { User } from "@/types";
import desktopDeviceRoutes from "./desktop-device.routes";

/**
 * The device routes behind a signed-in user, with the audit hook, so tests
 * can assert on the audit records of the mutating routes.
 */
export async function buildDesktopDeviceTestApp(params: {
  user: User;
  organizationId: string;
}) {
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    request.user = params.user;
    request.organizationId = params.organizationId;
  });
  registerAuditLogHook(app);
  await app.register(desktopDeviceRoutes);
  return app;
}
