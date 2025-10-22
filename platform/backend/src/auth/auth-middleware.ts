import type { Action, Resource } from "@shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "@/auth/auth";
import config from "@/config";
import { RouteId } from "@/types";
import { prepareErrorResponse } from "@/utils";

class AuthMiddleware {
  public handle = async (request: FastifyRequest, reply: FastifyReply) => {
    // custom logic to skip auth check
    if (this.shouldSkipAuthCheck(request)) return;

    // return 401 if unauthenticated
    if (await this.isUnauthenticated(request)) {
      return reply
        .status(401)
        .send(prepareErrorResponse("Unauthorized", request));
    }

    // check if authorized
    const permissionsStatus = await this.requiredPermissionsStatus(request);
    if ("success" in permissionsStatus && permissionsStatus.success) {
      return;
    }

    // return 403 if unauthorized
    return reply.status(403).send(prepareErrorResponse("Forbidden", request));
  };

  private shouldSkipAuthCheck = ({ url, method }: FastifyRequest) => {
    // Skip CORS preflight and HEAD requests globally
    if (method === "OPTIONS" || method === "HEAD") {
      return true;
    }

    if (
      url.startsWith("/api/auth") ||
      url.startsWith("/v1/openai") ||
      url.startsWith("/v1/anthropic") ||
      url.startsWith("/v1/gemini") ||
      url.startsWith("/json") ||
      url === "/openapi.json" ||
      url === "/health" ||
      url === "/api/features" ||
      url.startsWith(config.mcpGateway.endpoint)
    ) {
      return true;
    }
    return false;
  };

  private isUnauthenticated = async (request: FastifyRequest) => {
    const headers = new Headers(request.headers as HeadersInit);
    const session = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    });
    return !session;
  };

  private requiredPermissionsStatus = async (request: FastifyRequest) => {
    const routeId = request.routeOptions.schema?.operationId as
      | RouteId
      | undefined;
    if (!routeId) {
      return { error: "Forbidden" };
    }
    return await auth.api.hasPermission({
      headers: new Headers(request.headers as HeadersInit),
      body: {
        permissions: routePermissionsConfig[routeId] ?? {},
      },
    });
  };
}

/**
 * Routes not configured throws 403.
 * If a route should bypass the check, it should be configured in shouldSkipAuthCheck() method.
 * Each config has structure: { [routeId]: { [resource1]: [action1, action2], [resource2]: [action1] } }
 * That would mean that the route (routeId) requires all the permissions to pass the check:
 * `resource1:action1` AND `resource1:action2` AND `resource2:action1`
 */
const routePermissionsConfig: Partial<
  Record<RouteId, Partial<Record<Resource, Action[]>>>
> = {
  [RouteId.GetAgents]: {
    agent: ["read"],
  },
  [RouteId.GetAgent]: {
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
  [RouteId.GetAgentTools]: {
    agent: ["read"],
    tool: ["read"],
  },
  [RouteId.GetAllAgentTools]: {
    agent: ["read"],
    tool: ["read"],
  },
  [RouteId.GetUnassignedTools]: {
    tool: ["read"],
  },
  [RouteId.AssignToolToAgent]: {
    agent: ["update"],
  },
  [RouteId.UnassignToolFromAgent]: {
    agent: ["update"],
  },
  [RouteId.UpdateAgentTool]: {
    agent: ["update"],
    tool: ["update"],
  },
  [RouteId.GetTools]: {
    tool: ["read"],
  },
  [RouteId.GetInteractions]: {
    interaction: ["read"],
  },
  [RouteId.GetInteraction]: {
    interaction: ["read"],
  },
  [RouteId.GetOperators]: {
    policy: ["read"],
  },
  [RouteId.GetToolInvocationPolicies]: {
    policy: ["read"],
  },
  [RouteId.CreateToolInvocationPolicy]: {
    policy: ["create"],
  },
  [RouteId.GetToolInvocationPolicy]: {
    policy: ["read"],
  },
  [RouteId.UpdateToolInvocationPolicy]: {
    policy: ["update"],
  },
  [RouteId.DeleteToolInvocationPolicy]: {
    policy: ["delete"],
  },
  [RouteId.GetTrustedDataPolicies]: {
    policy: ["read"],
  },
  [RouteId.CreateTrustedDataPolicy]: {
    policy: ["create"],
  },
  [RouteId.GetTrustedDataPolicy]: {
    policy: ["read"],
  },
  [RouteId.UpdateTrustedDataPolicy]: {
    policy: ["update"],
  },
  [RouteId.DeleteTrustedDataPolicy]: {
    policy: ["delete"],
  },
  [RouteId.GetDefaultDualLlmConfig]: {
    dualLlmConfig: ["read"],
  },
  [RouteId.GetDualLlmConfigs]: {
    dualLlmConfig: ["read"],
  },
  [RouteId.GetDualLlmResultsByInteraction]: {
    dualLlmResult: ["read"],
  },
  [RouteId.CreateDualLlmConfig]: {
    dualLlmConfig: ["create"],
  },
  [RouteId.GetDualLlmConfig]: {
    dualLlmConfig: ["read"],
  },
  [RouteId.UpdateDualLlmConfig]: {
    dualLlmConfig: ["update"],
  },
  [RouteId.DeleteDualLlmConfig]: {
    dualLlmConfig: ["delete"],
  },
  [RouteId.GetDualLlmResultByToolCallId]: {
    dualLlmResult: ["read"],
  },
  [RouteId.GetMcpCatalog]: {
    mcpCatalog: ["read"],
  },
  [RouteId.CreateMcpCatalogItem]: {
    mcpCatalog: ["create"],
  },
  [RouteId.GetMcpCatalogItem]: {
    mcpCatalog: ["read"],
  },
  [RouteId.UpdateMcpCatalogItem]: {
    mcpCatalog: ["update"],
  },
  [RouteId.DeleteMcpCatalogItem]: {
    mcpCatalog: ["delete"],
  },
  [RouteId.GetMcpServers]: {
    mcpServer: ["read"],
  },
  [RouteId.GetMcpServer]: {
    mcpServer: ["read"],
  },
  [RouteId.InstallMcpServer]: {
    mcpServer: ["create"],
  },
  [RouteId.DeleteMcpServer]: {
    mcpServer: ["delete"],
  },
};

const authMiddleware = new AuthMiddleware();
export { authMiddleware };
