import { ResourceVisibilityScopeSchema, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  assertOauthClientTeams,
  authorizeOauthClientCreateScope,
  getOauthClientPermissionChecker,
  type OauthClientPermissionChecker,
  requireOauthClientModifyPermission,
  resolveOauthClientScopeUpdate,
  withOauthClientTeamFkErrorMapped,
} from "@/auth/oauth-client-permissions";
import { AgentModel, McpOauthClientModel, TeamModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  McpOauthClientGrantTypeSchema,
  McpOauthClientSchema,
  McpOauthClientWithSecretSchema,
} from "@/types";
import type { McpOauthClient } from "@/types/mcp-oauth-client";

/**
 * Both grant types share one body shape. `grantType` defaults to
 * `client_credentials` so existing callers keep working unchanged.
 * - client_credentials: requires `allowedGatewayIds` (the sole authority for the
 *   token); `redirectUris` is ignored.
 * - authorization_code: requires `redirectUris`. `allowedGatewayIds` is optional
 *   here and acts as an additive, admin-controlled grant — users who
 *   authenticate through the client may reach those gateways on top of their own
 *   RBAC. Empty means pure identity passthrough.
 *
 * `scope`/`teams` control who can see and manage the client (3-tier visibility
 * like agents), not what its tokens can reach at runtime. Create defaults to
 * `personal`; on update, omitted values leave the current scope/teams untouched.
 */
const McpOauthClientBodySchema = z
  .object({
    name: z.string().min(1).max(256),
    grantType: McpOauthClientGrantTypeSchema.default("client_credentials"),
    allowedGatewayIds: z.array(z.string().uuid()).optional(),
    redirectUris: z.array(z.string().url()).optional(),
    scope: ResourceVisibilityScopeSchema.optional(),
    teams: z.array(z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.grantType === "authorization_code") {
      if (!value.redirectUris || value.redirectUris.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["redirectUris"],
          message:
            "At least one redirect URI is required for authorization_code clients",
        });
      }
    } else if (
      !value.allowedGatewayIds ||
      value.allowedGatewayIds.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedGatewayIds"],
        message:
          "At least one gateway is required for client_credentials clients",
      });
    }
  });

const CreateMcpOauthClientBodySchema = McpOauthClientBodySchema;
const UpdateMcpOauthClientBodySchema = McpOauthClientBodySchema;

const mcpOauthClientsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/mcp-oauth-clients",
    {
      schema: {
        operationId: RouteId.GetMcpOauthClients,
        description: "List MCP OAuth clients that can access MCP gateways",
        tags: ["MCP OAuth Clients"],
        querystring: z.object({
          search: z.string().trim().min(1).optional(),
        }),
        response: constructResponseSchema(z.array(McpOauthClientSchema)),
      },
    },
    async ({ user, organizationId, query }, reply) => {
      const checker = await getOauthClientPermissionChecker({
        userId: user.id,
        organizationId,
        resource: "mcpOauthClient",
      });
      const oauthClients = await McpOauthClientModel.findAllByOrganization({
        organizationId,
        search: query.search,
        viewer: { userId: user.id, isAdmin: checker.isAdmin },
      });
      return reply.send(oauthClients);
    },
  );

  fastify.post(
    "/api/mcp-oauth-clients",
    {
      schema: {
        operationId: RouteId.CreateMcpOauthClient,
        description:
          "Create an MCP OAuth client and return its client secret once",
        tags: ["MCP OAuth Clients"],
        body: CreateMcpOauthClientBodySchema,
        response: constructResponseSchema(McpOauthClientWithSecretSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      const checker = await getOauthClientPermissionChecker({
        userId: user.id,
        organizationId,
        resource: "mcpOauthClient",
      });
      const scope = body.scope ?? "personal";
      const requestedTeams = body.teams ?? [];
      const userTeamIds = checker.isAdmin
        ? []
        : await TeamModel.getUserTeamIds(user.id);
      authorizeOauthClientCreateScope({
        checker,
        scope,
        teamIds: requestedTeams,
        userTeamIds,
      });
      // Omit teams if scope is not 'team' — scope takes precedence
      const teams = scope === "team" ? requestedTeams : [];
      await assertOauthClientTeams({ scope, teamIds: teams, organizationId });

      if (body.allowedGatewayIds && body.allowedGatewayIds.length > 0) {
        await validateMcpOauthClientConfig({
          organizationId,
          allowedGatewayIds: body.allowedGatewayIds,
        });
      }
      const { oauthClient, clientSecret } =
        await withOauthClientTeamFkErrorMapped(() =>
          McpOauthClientModel.create({
            organizationId,
            name: body.name,
            grantType: body.grantType,
            allowedGatewayIds: body.allowedGatewayIds,
            redirectUris: body.redirectUris,
            scope,
            teams,
            authorId: user.id,
          }),
        );
      return reply.send({ ...oauthClient, clientSecret });
    },
  );

  fastify.put(
    "/api/mcp-oauth-clients/:id",
    {
      schema: {
        operationId: RouteId.UpdateMcpOauthClient,
        description: "Update an MCP OAuth client",
        tags: ["MCP OAuth Clients"],
        params: z.object({ id: z.string() }),
        body: UpdateMcpOauthClientBodySchema,
        response: constructResponseSchema(McpOauthClientSchema),
      },
    },
    async ({ params, body, user, organizationId }, reply) => {
      const { existing, checker, userTeamIds } =
        await authorizeMcpOauthClientModify({
          id: params.id,
          userId: user.id,
          organizationId,
        });

      const resolvedTeams = resolveOauthClientScopeUpdate({
        checker,
        existingScope: existing.scope,
        existingTeamIds: existing.teams.map((team) => team.id),
        requestedScope: body.scope,
        requestedTeamIds: body.teams,
        userTeamIds,
      });
      // Omit teams if the final scope is not 'team' — scope takes precedence
      const finalScope = body.scope ?? existing.scope;
      const teams =
        finalScope === "team"
          ? resolvedTeams
          : resolvedTeams !== undefined
            ? []
            : undefined;
      await assertOauthClientTeams({
        scope: finalScope,
        teamIds: teams ?? existing.teams.map((team) => team.id),
        organizationId,
      });

      if (body.allowedGatewayIds && body.allowedGatewayIds.length > 0) {
        await validateMcpOauthClientConfig({
          organizationId,
          allowedGatewayIds: body.allowedGatewayIds,
        });
      }
      const oauthClient = await withOauthClientTeamFkErrorMapped(() =>
        McpOauthClientModel.update({
          id: params.id,
          organizationId,
          name: body.name,
          allowedGatewayIds: body.allowedGatewayIds,
          redirectUris: body.redirectUris,
          scope: body.scope,
          teams,
        }),
      );
      if (!oauthClient) {
        throw new ApiError(404, "MCP OAuth client not found");
      }
      return reply.send(oauthClient);
    },
  );

  fastify.post(
    "/api/mcp-oauth-clients/:id/rotate-secret",
    {
      schema: {
        operationId: RouteId.RotateMcpOauthClientSecret,
        description: "Rotate an MCP OAuth client's client secret",
        tags: ["MCP OAuth Clients"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(McpOauthClientWithSecretSchema),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      await authorizeMcpOauthClientModify({
        id: params.id,
        userId: user.id,
        organizationId,
      });
      const result = await McpOauthClientModel.rotateSecret({
        id: params.id,
        organizationId,
      });
      if (!result) {
        throw new ApiError(404, "MCP OAuth client not found");
      }
      return reply.send({
        ...result.oauthClient,
        clientSecret: result.clientSecret,
      });
    },
  );

  fastify.delete(
    "/api/mcp-oauth-clients/:id",
    {
      schema: {
        operationId: RouteId.DeleteMcpOauthClient,
        description: "Delete an MCP OAuth client",
        tags: ["MCP OAuth Clients"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      await authorizeMcpOauthClientModify({
        id: params.id,
        userId: user.id,
        organizationId,
      });
      const success = await McpOauthClientModel.delete({
        id: params.id,
        organizationId,
      });
      if (!success) {
        throw new ApiError(404, "MCP OAuth client not found");
      }
      return reply.send({ success });
    },
  );
};

export default mcpOauthClientsRoutes;

/**
 * Load the client and enforce 3-tier scope authorization for
 * update/rotate-secret/delete. Returns the client plus the checker/team
 * context so update can run its scope-change validation without re-fetching.
 */
async function authorizeMcpOauthClientModify(params: {
  id: string;
  userId: string;
  organizationId: string;
}): Promise<{
  existing: McpOauthClient;
  checker: OauthClientPermissionChecker;
  userTeamIds: string[];
}> {
  const existing = await McpOauthClientModel.findById({
    id: params.id,
    organizationId: params.organizationId,
  });
  if (!existing) {
    throw new ApiError(404, "MCP OAuth client not found");
  }
  const checker = await getOauthClientPermissionChecker({
    userId: params.userId,
    organizationId: params.organizationId,
    resource: "mcpOauthClient",
  });
  const userTeamIds = checker.isAdmin
    ? []
    : await TeamModel.getUserTeamIds(params.userId);
  requireOauthClientModifyPermission({
    checker,
    scope: existing.scope,
    authorId: existing.authorId,
    clientTeamIds: existing.teams.map((team) => team.id),
    userTeamIds,
    userId: params.userId,
  });
  return { existing, checker, userTeamIds };
}

async function validateMcpOauthClientConfig(params: {
  organizationId: string;
  allowedGatewayIds: string[];
}) {
  for (const gatewayId of params.allowedGatewayIds) {
    const agent = await AgentModel.findById(gatewayId);
    // An OAuth client may be scoped to MCP gateways and/or A2A agents (both are
    // reached by id through validateMCPGatewayToken). llm_proxy agents have
    // their own OAuth clients (allowedLlmProxyIds) and are not eligible here.
    if (
      !agent ||
      agent.organizationId !== params.organizationId ||
      (agent.agentType !== "mcp_gateway" && agent.agentType !== "agent")
    ) {
      throw new ApiError(404, "MCP gateway or agent not found");
    }
  }
}
