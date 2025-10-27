import type { Action, Resource } from "@shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "@/auth";
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
    const { success, error } = await this.requiredPermissionsStatus(request);
    if (success) {
      return;
    }

    // return 403 if unauthorized
    return reply
      .status(403)
      .send(prepareErrorResponse(error?.message ?? "Forbidden", request));
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
      url === "/metrics" ||
      url === "/api/features" ||
      url.startsWith(config.mcpGateway.endpoint)
    ) {
      return true;
    }
    return false;
  };

  private isUnauthenticated = async (request: FastifyRequest) => {
    const headers = new Headers(request.headers as HeadersInit);

    try {
      const session = await auth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });

      if (session) return false;
    } catch (_error) {
      /**
       * If getSession fails (e.g., "No active organization"), try API key verification
       */
      const authHeader = headers.get("authorization");
      if (authHeader) {
        try {
          const { valid } = await auth.api.verifyApiKey({
            body: { key: authHeader },
          });

          return !valid;
        } catch (_apiKeyError) {
          // API key verification failed, return unauthenticated
          return true;
        }
      }
    }

    return true;
  };

  private requiredPermissionsStatus = async (
    request: FastifyRequest,
  ): Promise<{ success: boolean; error: Error | null }> => {
    const routeId = request.routeOptions.schema?.operationId as
      | RouteId
      | undefined;
    if (!routeId) {
      return {
        success: false,
        error: new Error("Forbidden, routeId not found"),
      };
    }

    try {
      return await auth.api.hasPermission({
        headers: new Headers(request.headers as HeadersInit),
        body: {
          permissions: routePermissionsConfig[routeId] ?? {},
        },
      });
    } catch (_error) {
      /**
       * Handle API key sessions that don't have organization context
       * API keys have all permissions by default (see auth config)
       */
      const headers = new Headers(request.headers as HeadersInit);
      const authHeader = headers.get("authorization");

      if (authHeader) {
        try {
          // Verify if this is a valid API key
          const apiKeyResult = await auth.api.verifyApiKey({
            body: { key: authHeader },
          });
          if (apiKeyResult?.valid) {
            // API keys have all permissions, so allow the request
            return { success: true, error: null };
          }
        } catch (_apiKeyError) {
          // Not a valid API key, return original error
          return { success: false, error: new Error("Invalid API key") };
        }
      }
      return { success: false, error: new Error("No API key provided") };
    }
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
  [RouteId.GetDefaultAgent]: {
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
  [RouteId.GetInternalMcpCatalog]: {
    internalMcpCatalog: ["read"],
  },
  [RouteId.CreateInternalMcpCatalogItem]: {
    internalMcpCatalog: ["create"],
  },
  [RouteId.GetInternalMcpCatalogItem]: {
    internalMcpCatalog: ["read"],
  },
  [RouteId.UpdateInternalMcpCatalogItem]: {
    internalMcpCatalog: ["update"],
  },
  [RouteId.DeleteInternalMcpCatalogItem]: {
    internalMcpCatalog: ["delete"],
  },
  [RouteId.GetMcpServers]: {
    mcpServer: ["read"],
  },
  [RouteId.GetMcpServer]: {
    mcpServer: ["read"],
  },
  [RouteId.GetMcpServerTools]: {
    mcpServer: ["read"],
  },
  [RouteId.InstallMcpServer]: {
    mcpServer: ["create"],
  },
  [RouteId.DeleteMcpServer]: {
    mcpServer: ["delete"],
  },
  [RouteId.InitiateOAuth]: {
    mcpServer: ["create"],
  },
  [RouteId.HandleOAuthCallback]: {
    mcpServer: ["create"],
  },
  [RouteId.GetTeams]: {
    team: ["read"],
  },
  [RouteId.GetTeam]: {
    team: ["read"],
  },
  [RouteId.CreateTeam]: {
    team: ["create"],
  },
  [RouteId.UpdateTeam]: {
    team: ["update"],
  },
  [RouteId.DeleteTeam]: {
    team: ["delete"],
  },
  [RouteId.GetTeamMembers]: {
    team: ["read"],
  },
  [RouteId.AddTeamMember]: {
    team: ["update"],
  },
  [RouteId.RemoveTeamMember]: {
    team: ["update"],
  },
};

const authMiddleware = new AuthMiddleware();
export { authMiddleware };
