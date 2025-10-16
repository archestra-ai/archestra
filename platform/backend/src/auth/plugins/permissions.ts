import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import {
  requireAllPermissions,
  requireAnyPermission,
  requirePermission,
} from "@/middleware/permission-middleware";

/**
 * Fastify plugin to add Better Auth permission helpers
 */
async function permissionsPlugin(fastify: FastifyInstance) {
  // Decorate fastify instance with permission helpers
  fastify.decorate("permissions", {
    require: requirePermission,
    requireAll: requireAllPermissions,
    requireAny: requireAnyPermission,
  });
}

export default fp(permissionsPlugin, {
  name: "permissions",
});

// Type augmentation for TypeScript
declare module "fastify" {
  interface FastifyInstance {
    permissions: {
      require: typeof requirePermission;
      requireAll: typeof requireAllPermissions;
      requireAny: typeof requireAnyPermission;
    };
  }
}
