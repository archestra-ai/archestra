import {
  type Action,
  getResourceFromPath,
  METHOD_TO_ACTION,
  type Permission,
  type Resource,
} from "@shared";
import { createAccessControl } from "better-auth/plugins/access";
import type {
  FastifyReply,
  FastifyRequest,
  RouteShorthandOptions,
} from "fastify";
import { auth } from "@/auth";
import { RouteId } from "@/types";
import { checkPermission } from "./permission-middleware";

class AuthMiddleware {
  constructor() {}

  public async handle(request: FastifyRequest, reply: FastifyReply) {
    // custom logic to skip auth check
    if (this.shouldSkipAuthCheck(request)) return;

    // return 401 if unauthenticated
    if (await this.isUnauthenticated(request)) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    // return 403 if unauthorized
    const isAuthorized = await this.isAuthorized(request);
    if ("success" in isAuthorized && isAuthorized.success) {
      return;
    }

    return reply.status(403).send({ error: isAuthorized.error });
  }

  private shouldSkipAuthCheck({ url }: FastifyRequest) {
    if (
      url.startsWith("/api/auth") ||
      url.startsWith("/v1/openai") ||
      url.startsWith("/v1/anthropic") ||
      url.startsWith("/v1/gemini") ||
      url === "/openapi.json" ||
      url === "/health"
    ) {
      return true;
    }
    return false;
  }

  private async isUnauthenticated(request: FastifyRequest) {
    const headers = new Headers(request.headers as HeadersInit);
    const session = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    });
    return Boolean(session);
  }

  private async isAuthorized(request: FastifyRequest) {
    const routeId = request.routeOptions.schema?.operationId as
      | RouteId
      | undefined;
    if (!routeId) {
      return { error: "Forbidden" };
    }

    const requiredActions = routePermissionsConfig[routeId];

    const headers = new Headers(request.headers as HeadersInit);
    return await auth.api.hasPermission({
      headers,
      body: {
        permissions: {
          [routeId]: requiredActions,
        },
      },
    });
  }
}

// routes not configured throws 403
const routePermissionsConfig: Partial<
  Record<RouteId, Partial<Record<Resource, Action[]>>>
> = {
  [RouteId.GetAgents]: {
    agent: ["read"],
  },
  [RouteId.CreateAgent]: {
    agent: ["create"],
  },
  [RouteId.UpdateAgent]: {
    agent: ["update"],
  },
  [RouteId.DeleteAgent]: {
    agent: ["delete"],
  },
  [RouteId.GetTools]: {
    tool: ["read"],
  },
  [RouteId.UpdateTool]: {
    tool: ["update"],
  },
};

/**
 * Create Access Control instance
 */
const availableActions: Record<Resource, Action[]> = {
  agent: ["create", "read", "update", "delete"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  dualLlmConfig: ["create", "read", "update", "delete"],
  dualLlmResult: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  settings: ["read", "update"],
  organization: ["create", "read", "update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create"],
};
export const ac = createAccessControl(availableActions);

/**
 * Owner role - has all permissions
 */
export const ownerRole = ac.newRole({
  agent: ["create", "read", "update", "delete"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  dualLlmConfig: ["create", "read", "update", "delete"],
  dualLlmResult: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  settings: ["read", "update"],
  organization: ["create", "read", "update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create"],
});

/**
 * Admin role - has all permissions except org deletion/transfer
 */
export const adminRole = ac.newRole({
  agent: ["create", "read", "update", "delete"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  dualLlmConfig: ["create", "read", "update", "delete"],
  dualLlmResult: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  settings: ["read", "update"],
  organization: ["create", "read", "update"],
  member: ["create", "update", "delete"],
  invitation: ["create"],
});

/**
 * Member role - read-only access
 */
export const memberRole = ac.newRole({
  agent: ["read"],
  tool: ["read"],
  policy: ["read"],
  dualLlmConfig: ["read"],
  dualLlmResult: ["read"],
  interaction: ["read"],
  settings: ["read"],
  organization: ["read"],
  member: [],
  invitation: [],
});

const authMiddleware2 = new AuthMiddleware();
export { authMiddleware2 };

const routeIsUnauthenticated = (request: FastifyRequest) => {
  return (
    request.url.startsWith("/api/auth") ||
    request.url.startsWith("/v1/openai") ||
    request.url.startsWith("/v1/anthropic") ||
    request.url.startsWith("/v1/gemini") ||
    request.url === "/openapi.json"
  );
};

export const authMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  if (routeIsUnauthenticated(request)) return;

  const headers = new Headers();
  Object.entries(request.headers).forEach(([key, value]) => {
    if (value) headers.append(key, value.toString());
  });

  try {
    const session = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    });
    if (!session) {
      reply.status(401).send({ error: "Unauthorized" });
      return;
    }
    const hasExplicitPermissionCheck = (
      request.routeOptions as RouteShorthandOptions
    )?.preHandler;

    if (!hasExplicitPermissionCheck) {
      const resource = getResourceFromPath(request.url);
      const action = METHOD_TO_ACTION[request.method];

      if (resource && action) {
        const permission = `${resource}:${action}`;

        try {
          const permission = `${resource}:${action}` as Permission;
          const hasPermission = await checkPermission(request, permission);
          if (!hasPermission) {
            return reply.status(403).send({
              error: `Permission denied. Required permission: ${permission}`,
            });
          }
        } catch (error) {
          console.error(`Permission check failed for ${permission}:`, error);
          return reply.status(403).send({
            error: "Permission check failed",
          });
        }
      }
    }
  } catch (_err) {
    reply.status(401).send({ error: "Invalid session" });
  }
};
