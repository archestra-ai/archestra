import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { McpServerInstallationRequestModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertMcpServerInstallationRequestSchema,
  type McpServerInstallationRequest,
  McpServerInstallationRequestStatusSchema,
  SelectMcpServerInstallationRequestSchema,
  UpdateMcpServerInstallationRequestSchema,
  UuidIdSchema,
} from "@/types";

const mcpServerInstallationRequestRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
  fastify.get(
    "/api/mcp_server_installation_requests",
    {
      schema: {
        operationId: RouteId.GetMcpServerInstallationRequests,
        description: "Get all MCP server installation requests",
        tags: ["MCP Server Installation Requests"],
        querystring: z.object({
          status:
            McpServerInstallationRequestStatusSchema.optional().describe(
              "Filter by status",
            ),
        }),
        response: constructResponseSchema(
          z.array(SelectMcpServerInstallationRequestSchema),
        ),
      },
    },
    async ({ query: { status }, user, headers }, reply) => {
      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServer: ["admin"] },
        headers,
      );

      let requests: McpServerInstallationRequest[];
      if (isMcpServerAdmin) {
        // MCP server admins can see all requests
        requests = status
          ? await McpServerInstallationRequestModel.findByStatus(status)
          : await McpServerInstallationRequestModel.findAll();
      } else {
        requests = await McpServerInstallationRequestModel.findByRequestedBy(
          user.id,
        );
        if (status) {
          requests = requests.filter((r) => r.status === status);
        }
      }

      return reply.send(requests);
    },
  );

  fastify.post(
    "/api/mcp_server_installation_requests",
    {
      schema: {
        operationId: RouteId.CreateMcpServerInstallationRequest,
        description: "Create a new MCP server installation request",
        tags: ["MCP Server Installation Requests"],
        body: InsertMcpServerInstallationRequestSchema,
        response: constructResponseSchema(
          SelectMcpServerInstallationRequestSchema,
        ),
      },
    },
    async ({ body, user }, reply) => {
      // Check if there's already a pending request for this external catalog item
      if (body.externalCatalogId) {
        const existingExternalRequests =
          await McpServerInstallationRequestModel.findAll();
        const duplicateRequest = existingExternalRequests.find(
          (req) =>
            req.status === "pending" &&
            req.externalCatalogId === body.externalCatalogId,
        );

        if (duplicateRequest) {
          throw new ApiError(
            400,
            "A pending installation request already exists for this external MCP server",
          );
        }
      }

      const newRequest = await McpServerInstallationRequestModel.create(
        user.id,
        body,
      );

      return reply.send(newRequest);
    },
  );

  fastify.get(
    "/api/mcp_server_installation_requests/:id",
    {
      schema: {
        operationId: RouteId.GetMcpServerInstallationRequest,
        description: "Get an MCP server installation request by ID",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(
          SelectMcpServerInstallationRequestSchema,
        ),
      },
    },
    async ({ params: { id }, user, headers }, reply) => {
      const installationRequest =
        await McpServerInstallationRequestModel.findById(id);

      if (!installationRequest) {
        throw new ApiError(404, "Installation request not found");
      }

      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServer: ["admin"] },
        headers,
      );

      // MCP server admins can view all requests, non-MCP server admins can only view their own requests
      if (!isMcpServerAdmin && installationRequest.requestedBy !== user.id) {
        throw new ApiError(403, "Forbidden");
      }

      return reply.send(installationRequest);
    },
  );

  fastify.patch(
    "/api/mcp_server_installation_requests/:id",
    {
      schema: {
        operationId: RouteId.UpdateMcpServerInstallationRequest,
        description: "Update an MCP server installation request",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateMcpServerInstallationRequestSchema.partial(),
        response: constructResponseSchema(
          SelectMcpServerInstallationRequestSchema,
        ),
      },
    },
    async ({ params: { id }, body, headers }, reply) => {
      const { status, adminResponse, reviewedBy, reviewedAt } = body;
      const installationRequest =
        await McpServerInstallationRequestModel.findById(id);

      if (!installationRequest) {
        throw new ApiError(404, "Installation request not found");
      }

      // MCP server admins can update status, non-MCP server admins can only update their own requests
      if (status || adminResponse || reviewedBy || reviewedAt) {
        const { success: isMcpServerAdmin } = await hasPermission(
          { mcpServer: ["admin"] },
          headers,
        );

        if (!isMcpServerAdmin) {
          throw new ApiError(
            403,
            "Only admins can approve or decline requests",
          );
        }
      }

      const updatedRequest = await McpServerInstallationRequestModel.update(
        id,
        body,
      );

      if (!updatedRequest) {
        throw new ApiError(404, "Installation request not found");
      }

      return reply.send(updatedRequest);
    },
  );

  fastify.post(
    "/api/mcp_server_installation_requests/:id/approve",
    {
      schema: {
        operationId: RouteId.ApproveMcpServerInstallationRequest,
        description: "Approve an MCP server installation request",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          adminResponse: z.string().optional(),
        }),
        response: constructResponseSchema(
          SelectMcpServerInstallationRequestSchema,
        ),
      },
    },
    async ({ params: { id }, body, user }, reply) => {
      const installationRequest =
        await McpServerInstallationRequestModel.findById(id);

      if (!installationRequest) {
        throw new ApiError(404, "Installation request not found");
      }

      const updatedRequest = await McpServerInstallationRequestModel.approve(
        id,
        user.id,
        body.adminResponse,
      );

      if (!updatedRequest) {
        throw new ApiError(404, "Installation request not found");
      }

      return reply.send(updatedRequest);
    },
  );

  fastify.post(
    "/api/mcp_server_installation_requests/:id/decline",
    {
      schema: {
        operationId: RouteId.DeclineMcpServerInstallationRequest,
        description: "Decline an MCP server installation request",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          adminResponse: z.string().optional(),
        }),
        response: constructResponseSchema(
          SelectMcpServerInstallationRequestSchema,
        ),
      },
    },
    async ({ params: { id }, body: { adminResponse }, user }, reply) => {
      const installationRequest =
        await McpServerInstallationRequestModel.findById(id);

      if (!installationRequest) {
        throw new ApiError(404, "Installation request not found");
      }

      const updatedRequest = await McpServerInstallationRequestModel.decline(
        id,
        user.id,
        adminResponse,
      );

      if (!updatedRequest) {
        throw new ApiError(404, "Installation request not found");
      }

      return reply.send(updatedRequest);
    },
  );

  fastify.post(
    "/api/mcp_server_installation_requests/:id/notes",
    {
      schema: {
        operationId: RouteId.AddMcpServerInstallationRequestNote,
        description: "Add a note to an MCP server installation request",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          content: z.string().min(1),
        }),
        response: constructResponseSchema(
          SelectMcpServerInstallationRequestSchema,
        ),
      },
    },
    async ({ params: { id }, body: { content }, user, headers }, reply) => {
      const installationRequest =
        await McpServerInstallationRequestModel.findById(id);

      if (!installationRequest) {
        throw new ApiError(404, "Installation request not found");
      }

      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServer: ["admin"] },
        headers,
      );

      // MCP server admins can add notes to all requests, non-MCP server admins can only add notes to their own requests
      if (!isMcpServerAdmin && installationRequest.requestedBy !== user.id) {
        throw new ApiError(403, "Forbidden");
      }

      const updatedRequest = await McpServerInstallationRequestModel.addNote(
        id,
        user.id,
        user.name,
        content,
      );

      if (!updatedRequest) {
        throw new ApiError(404, "Installation request not found");
      }

      return reply.send(updatedRequest);
    },
  );

  fastify.delete(
    "/api/mcp_server_installation_requests/:id",
    {
      schema: {
        operationId: RouteId.DeleteMcpServerInstallationRequest,
        description: "Delete an MCP server installation request",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      const success = await McpServerInstallationRequestModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Installation request not found");
      }

      return reply.send({ success });
    },
  );
};

export default mcpServerInstallationRequestRoutes;
