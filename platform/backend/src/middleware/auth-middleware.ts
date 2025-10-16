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
import { RouteId } from "@/types";
import { checkPermission } from "./permission-middleware";

class AuthMiddleware {
  constructor() {}

  public async handle(request: FastifyRequest, reply: FastifyReply) {
    // custom logic to skip auth check
    if (this.shouldSkipAuthCheck(request)) return;

    // route ids to skip auth check
  }

  private shouldSkipAuthCheck({ url, routeOptions }: FastifyRequest) {
    if (
      url.startsWith("/api/auth") ||
      url.startsWith("/v1/openai") ||
      url.startsWith("/v1/anthropic") ||
      url.startsWith("/v1/gemini") ||
      url === "/openapi.json" ||
      url.startsWith("/health")
    ) {
      return true;
    }

    if (
      routeOptions.schema?.operationId &&
      ROUTES_TO_SKIP_AUTH_CHECK.includes(
        routeOptions.schema.operationId as RouteId,
      )
    ) {
      return true;
    }
    return false;
  }
}

const ROUTES_TO_SKIP_AUTH_CHECK: RouteId[] = [
  RouteId.OpenAiChatCompletionsWithDefaultAgent,
  RouteId.OpenAiChatCompletionsWithAgent,
  RouteId.AnthropicMessagesWithDefaultAgent,
  RouteId.AnthropicMessagesWithAgent,
];

const authMiddleware2 = new AuthMiddleware();
export default authMiddleware2;

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
