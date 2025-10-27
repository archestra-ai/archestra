import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { McpServerInstallationRequestModel } from "@/models";
import {
  ErrorResponseSchema,
  InsertMcpServerInstallationRequestSchema,
  RouteId,
  SelectMcpServerInstallationRequestSchema,
  UuidIdSchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";

const mcpServerInstallationRequestRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
  // Get all installation requests (optionally filtered by status)
  fastify.get(
    "/api/mcp_server_installation_request",
    {
      schema: {
        operationId: RouteId.GetMcpServerInstallationRequests,
        description:
          "Get all MCP server installation requests (optionally filtered by status)",
        tags: ["MCP Server Installation Request"],
        querystring: z.object({
          status: z.enum(["pending", "approved", "declined"]).optional(),
        }),
        response: {
          200: z.array(SelectMcpServerInstallationRequestSchema),
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const { status } = request.query;

        // Admins can see all requests, members can only see their own
        let requests;
        if (user.isAdmin) {
          requests = await McpServerInstallationRequestModel.findAll(status);
        } else {
          const allUserRequests =
            await McpServerInstallationRequestModel.findByUser(user.id);
          // Filter by status if provided
          requests = status
            ? allUserRequests.filter((req) => req.status === status)
            : allUserRequests;
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

  // Get a specific installation request by ID
  fastify.get(
    "/api/mcp_server_installation_request/:id",
    {
      schema: {
        operationId: RouteId.GetMcpServerInstallationRequest,
        description: "Get an MCP server installation request by ID",
        tags: ["MCP Server Installation Request"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const installationRequest =
          await McpServerInstallationRequestModel.findById(request.params.id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        // Members can only see their own requests, admins can see all
        if (!user.isAdmin && installationRequest.requestedBy !== user.id) {
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

  // Create a new installation request
  fastify.post(
    "/api/mcp_server_installation_request",
    {
      schema: {
        operationId: RouteId.CreateMcpServerInstallationRequest,
        description: "Create a new MCP server installation request",
        tags: ["MCP Server Installation Request"],
        body: InsertMcpServerInstallationRequestSchema.omit({
          id: true,
          requestedBy: true,
          status: true,
          reviewedBy: true,
          reviewedAt: true,
          reviewNotes: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Check if user already has a pending request for this catalog item
        const existingRequest =
          await McpServerInstallationRequestModel.findPendingRequestForCatalogByUser(
            request.body.catalogId,
            user.id,
          );

        if (existingRequest) {
          return reply.status(400).send({
            error: {
              message:
                "You already have a pending installation request for this MCP server",
              type: "validation_error",
            },
          });
        }

        const installationRequest =
          await McpServerInstallationRequestModel.create({
            ...request.body,
            requestedBy: user.id,
            status: "pending",
          });

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

  // Update an installation request (generic update)
  fastify.put(
    "/api/mcp_server_installation_request/:id",
    {
      schema: {
        operationId: RouteId.UpdateMcpServerInstallationRequest,
        description: "Update an MCP server installation request",
        tags: ["MCP Server Installation Request"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: InsertMcpServerInstallationRequestSchema.omit({
          id: true,
          requestedBy: true,
          createdAt: true,
          updatedAt: true,
        }).partial(),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const installationRequest =
          await McpServerInstallationRequestModel.update(
            request.params.id,
            request.body,
          );

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
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

  // Approve an installation request (admin only)
  fastify.post(
    "/api/mcp_server_installation_request/:id/approve",
    {
      schema: {
        operationId: RouteId.ApproveMcpServerInstallationRequest,
        description: "Approve an MCP server installation request",
        tags: ["MCP Server Installation Request"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          reviewNotes: z.string().optional(),
        }),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const installationRequest =
          await McpServerInstallationRequestModel.approve(
            request.params.id,
            user.id,
            request.body.reviewNotes,
          );

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
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

  // Decline an installation request (admin only)
  fastify.post(
    "/api/mcp_server_installation_request/:id/decline",
    {
      schema: {
        operationId: RouteId.DeclineMcpServerInstallationRequest,
        description: "Decline an MCP server installation request",
        tags: ["MCP Server Installation Request"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          reviewNotes: z.string().optional(),
        }),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const installationRequest =
          await McpServerInstallationRequestModel.decline(
            request.params.id,
            user.id,
            request.body.reviewNotes,
          );

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
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

  // Delete an installation request
  fastify.delete(
    "/api/mcp_server_installation_request/:id",
    {
      schema: {
        operationId: RouteId.DeleteMcpServerInstallationRequest,
        description: "Delete an MCP server installation request",
        tags: ["MCP Server Installation Request"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send({
          success: await McpServerInstallationRequestModel.delete(
            request.params.id,
          ),
        });
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
