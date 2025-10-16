import {
  getResourceFromPath,
  METHOD_TO_ACTION,
  type Permission,
} from "@shared";
import type {
  FastifyReply,
  FastifyRequest,
  RouteShorthandOptions,
} from "fastify";
import { auth } from "@/auth";
import { checkPermission } from "./permission-middleware";

export const authMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  if (request.url.startsWith("/api/auth")) return;
  if (request.url === "/openapi.json") return;

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
