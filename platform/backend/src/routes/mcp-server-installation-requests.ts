import { RouteId } from "@shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import db, { schema } from "@/database";
import { McpServerInstallationRequestModel } from "@/models";
import {
  constructResponseSchema,
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
      try {
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
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );

  fastify.post(
    "/api/mcp_server_installation_requests",
    {
      schema: {
        operationId: RouteId.CreateMcpServerInstallationRequest,
        description: "Create a new MCP server installation request",
        tags: ["MCP Server Installation Requests"],
        body: InsertMcpServerInstallationRequestSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
          requestedBy: true,
          status: true,
          reviewedBy: true,
          reviewedAt: true,
          adminResponse: true,
          notes: true,
        }),
        response: constructResponseSchema(
          SelectMcpServerInstallationRequestSchema,
        ),
      },
    },
    async ({ body, user }, reply) => {
      try {
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
            return reply.status(400).send({
              error: {
                message:
                  "A pending installation request already exists for this external MCP server",
                type: "bad_request",
              },
            });
          }
        }

        const newRequest = await McpServerInstallationRequestModel.create({
          ...body,
          requestedBy: user.id,
        });

        return reply.send(newRequest);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
      try {
        const installationRequest =
          await McpServerInstallationRequestModel.findById(id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        const { success: isMcpServerAdmin } = await hasPermission(
          { mcpServer: ["admin"] },
          headers,
        );

        // MCP server admins can view all requests, non-MCP server admins can only view their own requests
        if (!isMcpServerAdmin && installationRequest.requestedBy !== user.id) {
          return reply.status(403).send({
            error: {
              message: "Forbidden",
              type: "forbidden",
            },
          });
        }

        return reply.send(installationRequest);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
        body: UpdateMcpServerInstallationRequestSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
          externalCatalogId: true,
          requestedBy: true,
        }).partial(),
        response: constructResponseSchema(
          SelectMcpServerInstallationRequestSchema,
        ),
      },
    },
    async ({ params: { id }, body, headers }, reply) => {
      try {
        const installationRequest =
          await McpServerInstallationRequestModel.findById(id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        // MCP server admins can update status, non-MCP server admins can only update their own requests
        if (
          body.status ||
          body.adminResponse ||
          body.reviewedBy ||
          body.reviewedAt
        ) {
          const { success: isMcpServerAdmin } = await hasPermission(
            { mcpServer: ["admin"] },
            headers,
          );

          if (!isMcpServerAdmin) {
            return reply.status(403).send({
              error: {
                message: "Only admins can approve or decline requests",
                type: "forbidden",
              },
            });
          }
        }

        const updatedRequest = await McpServerInstallationRequestModel.update(
          id,
          body,
        );

        if (!updatedRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        return reply.send(updatedRequest);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
      try {
        const installationRequest =
          await McpServerInstallationRequestModel.findById(id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        const updatedRequest = await McpServerInstallationRequestModel.approve(
          id,
          user.id,
          body.adminResponse,
        );

        if (!updatedRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        return reply.send(updatedRequest);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
    async ({ params: { id }, body, user }, reply) => {
      try {
        const installationRequest =
          await McpServerInstallationRequestModel.findById(id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        const updatedRequest = await McpServerInstallationRequestModel.decline(
          id,
          user.id,
          body.adminResponse,
        );

        if (!updatedRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        return reply.send(updatedRequest);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
    async ({ params: { id }, body, user, headers }, reply) => {
      try {
        const installationRequest =
          await McpServerInstallationRequestModel.findById(id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        const { success: isMcpServerAdmin } = await hasPermission(
          { mcpServer: ["admin"] },
          headers,
        );

        // MCP server admins can add notes to all requests, non-MCP server admins can only add notes to their own requests
        if (!isMcpServerAdmin && installationRequest.requestedBy !== user.id) {
          return reply.status(403).send({
            error: {
              message: "Forbidden",
              type: "forbidden",
            },
          });
        }

        // Get user name from database
        const [userData] = await db
          .select()
          .from(schema.usersTable)
          .where(eq(schema.usersTable.id, user.id));

        const updatedRequest = await McpServerInstallationRequestModel.addNote(
          id,
          user.id,
          userData.name,
          body.content,
        );

        if (!updatedRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        return reply.send(updatedRequest);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id } }, reply) => {
      try {
        const success = await McpServerInstallationRequestModel.delete(id);

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        return reply.send({ success });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );
};

export default mcpServerInstallationRequestRoutes;
