import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
  userHasPermission,
} from "@/auth";
import config from "@/config";
import logger from "@/logging";
import {
  A2ATaskModel,
  AgentModel,
  AgentRunModel,
  AgentRunShareModel,
  MemberModel,
  ProjectModel,
  ProjectShareModel,
  TeamModel,
} from "@/models";
import {
  isAnyAgentRuntimeBackendDriverEnabled,
  resolveAgentRuntimeBackendDriver,
} from "@/services/agent-runtime/backends";
import {
  deleteAgentRuntimeCredential,
  preflightAgentRuntimeCredentials,
  setAgentRuntimeCredential,
} from "@/services/agent-runtime/credentials";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import {
  cancelDetachedAgentTask,
  startDetachedAgentTask,
} from "@/services/agent-runtime/start-task";
import {
  type Agent,
  type AgentRunSession,
  AgentRunShareVisibilitySchema,
  type AgentRunStartupProgress,
  ApiError,
  constructResponseSchema,
  GetAgentRunResponseSchema,
  MissingAgentRuntimeCredentialSchema,
  type ResolvedAgentRuntime,
  SelectAgentRunSchema,
  SelectAgentRunSessionSchema,
  SelectAgentRunShareWithTargetsSchema,
  StartAgentRunResponseSchema,
  UpdateAgentRunSchema,
} from "@/types";

const agentRuntimeRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("preHandler", async () => {
    if (!isAnyAgentRuntimeBackendDriverEnabled())
      throw new ApiError(404, "Not found");
  });

  fastify.get(
    "/api/agents/:id/runtime/preflight",
    {
      schema: {
        operationId: RouteId.GetAgentRuntimePreflight,
        description:
          "Report credentials the current user still needs before this Agent can execute delegated work in its runtime",
        tags: ["Agents"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(
          z.object({
            ready: z.boolean(),
            configured: z.array(z.string()),
            missing: z.array(MissingAgentRuntimeCredentialSchema),
            misconfigured: z.array(MissingAgentRuntimeCredentialSchema),
          }),
        ),
      },
    },
    async (request, reply) => {
      const runtime = await requireReadableAgentRuntimeOnly(request);
      const preflight = await preflightAgentRuntimeCredentials({
        runtime,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      return reply.send({
        ready:
          preflight.missing.length === 0 &&
          preflight.misconfigured.length === 0,
        ...preflight,
      });
    },
  );

  fastify.put(
    "/api/agents/:id/runtime/credentials/:key",
    {
      schema: {
        operationId: RouteId.SetAgentRuntimeCredential,
        description:
          "Store or replace one credential declared by an Agent's Agent Runtime configuration",
        tags: ["Agents"],
        params: z.object({
          id: z.string().uuid(),
          key: z.string().min(1).max(128),
        }),
        body: z.object({ value: z.string().min(1).max(20_000) }),
        response: constructResponseSchema(
          z.object({ configured: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      const { agent, runtime } = await requireReadableAgentRuntime(request);
      const declaration = requireCredentialDeclaration(
        runtime,
        request.params.key,
      );
      if (declaration.scope === "shared") {
        if (declaration.credentialId) {
          await requireRuntimeCredentialAdmin(request);
          const before = await preflightAgentRuntimeCredentials({
            runtime,
            organizationId: request.organizationId,
            userId: request.user.id,
          });
          request.auditBefore = {
            runtimeConnection: {
              credentialId: declaration.credentialId,
              configured: before.configured.includes(declaration.key),
            },
          };
          request.auditAfter = {
            runtimeConnection: {
              credentialId: declaration.credentialId,
              configured: true,
            },
          };
        } else {
          await requireWritableAgent({ request, agent });
        }
      } else {
        request.auditSkip = true;
      }
      await setAgentRuntimeCredential({
        runtime,
        organizationId: request.organizationId,
        userId: request.user.id,
        key: declaration.key,
        value: request.body.value,
      });
      return reply.send({ configured: true as const });
    },
  );

  fastify.delete(
    "/api/agents/:id/runtime/credentials/:key",
    {
      schema: {
        operationId: RouteId.DeleteAgentRuntimeCredential,
        description:
          "Remove one stored Agent Runtime credential value without changing its declaration",
        tags: ["Agents"],
        params: z.object({
          id: z.string().uuid(),
          key: z.string().min(1).max(128),
        }),
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async (request, reply) => {
      const { agent, runtime } = await requireReadableAgentRuntime(request);
      const declaration = requireCredentialDeclaration(
        runtime,
        request.params.key,
      );
      if (declaration.scope === "shared") {
        if (declaration.credentialId) {
          await requireRuntimeCredentialAdmin(request);
          request.auditBefore = {
            runtimeConnection: {
              credentialId: declaration.credentialId,
              configured: true,
            },
          };
          request.auditAfter = {
            runtimeConnection: {
              credentialId: declaration.credentialId,
              configured: false,
            },
          };
        } else {
          await requireWritableAgent({ request, agent });
        }
      } else {
        request.auditSkip = true;
      }
      const result = await deleteAgentRuntimeCredential({
        runtime,
        organizationId: request.organizationId,
        userId: request.user.id,
        key: declaration.key,
      });
      if (!result.deleted) {
        throw new ApiError(404, "Credential is not configured");
      }
      return reply.send({ deleted: true });
    },
  );

  fastify.get(
    "/api/agents/:id/runs",
    {
      schema: {
        operationId: RouteId.GetAgentRuns,
        description:
          "List Agent Runtime runs created by delegated tasks for this Agent",
        tags: ["Agents"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.array(SelectAgentRunSchema)),
      },
    },
    async (request, reply) => {
      await requireReadableAgent(request);
      return reply.send(
        await AgentRunModel.listForAgent({
          agentId: request.params.id,
          organizationId: request.organizationId,
        }),
      );
    },
  );

  fastify.post(
    "/api/agents/:id/runs",
    {
      schema: {
        operationId: RouteId.StartAgentRun,
        description: "Start a durable Agent Runtime session with this Agent",
        tags: ["Agents"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          message: z.string().trim().min(1).max(100_000),
          projectId: z.string().uuid().optional(),
          attachments: z
            .array(
              z
                .object({
                  name: z.string().trim().min(1).max(255),
                  contentType: z.string().trim().min(1).max(255),
                  contentBase64: z
                    .string()
                    .min(1)
                    .refine(
                      isCanonicalBase64,
                      "Attachment content is not valid base64",
                    ),
                })
                .superRefine((attachment, context) => {
                  const bytes = Buffer.from(attachment.contentBase64, "base64");
                  if (bytes.byteLength === 0) {
                    context.addIssue({
                      code: "custom",
                      message: "Attachment content is not valid base64",
                    });
                  }
                  if (
                    bytes.byteLength > config.chat.attachmentStorageBytesLimit
                  ) {
                    context.addIssue({
                      code: "custom",
                      message: `Attachments may not exceed ${config.chat.attachmentStorageBytesLimit} bytes`,
                    });
                  }
                }),
            )
            .max(20)
            .optional(),
        }),
        response: constructResponseSchema(StartAgentRunResponseSchema),
      },
    },
    async (request, reply) => {
      const { agent, runtime } = await requireReadableAgentRuntime(request);
      if (request.body.projectId) {
        await requireReadableProject({
          projectId: request.body.projectId,
          organizationId: request.organizationId,
          userId: request.user.id,
        });
      }
      const preflight = await preflightAgentRuntimeCredentials({
        runtime,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      if (preflight.missing.length > 0) {
        throw new ApiError(
          409,
          `Add your required credentials before starting this run: ${preflight.missing
            .map((entry) => entry.label)
            .join(", ")}`,
        );
      }
      if (preflight.misconfigured.length > 0) {
        throw new ApiError(
          409,
          `An Agent administrator must configure: ${preflight.misconfigured
            .map((entry) => entry.label)
            .join(", ")}`,
        );
      }

      const task = await startDetachedAgentTask({
        actor: {
          id: request.user.id,
          kind: "user",
          organizationId: request.organizationId,
        },
        agentId: agent.id,
        message: request.body.message,
        attachments: request.body.attachments,
        systemParams: {
          sessionId: crypto.randomUUID(),
          source: "chat",
          projectId: request.body.projectId,
          runtimeMode: "interactive",
        },
      });
      request.auditResourceId = { value: task.id };
      request.auditAfter = {
        taskId: task.id,
        agentId: agent.id,
        state: task.state,
        attachmentCount: request.body.attachments?.length ?? 0,
        projectId: request.body.projectId ?? null,
      };
      return reply.send({
        taskId: task.id,
        state: task.state,
        agentId: agent.id,
        agentName: agent.name,
        prompt: request.body.message,
        projectId: request.body.projectId ?? null,
        createdAt: task.createdAt,
      });
    },
  );

  fastify.get(
    "/api/agent-runs",
    {
      schema: {
        operationId: RouteId.GetMyAgentRuns,
        description: "List Agent Runtime runs started by this user",
        tags: ["Agents"],
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectAgentRunSessionSchema),
        ),
      },
    },
    async (request, reply) => {
      return reply.send(
        await AgentRunModel.listForActor({
          actorUserId: request.user.id,
          organizationId: request.organizationId,
          pagination: request.query,
        }),
      );
    },
  );

  fastify.get(
    "/api/agent-runs/:taskId",
    {
      schema: {
        operationId: RouteId.GetMyAgentRun,
        description:
          "Get one Agent Runtime the user started or was granted access to",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        response: constructResponseSchema(GetAgentRunResponseSchema),
      },
    },
    async (request, reply) => {
      const owned = await AgentRunModel.findForActorByTaskId({
        taskId: request.params.taskId,
        actorUserId: request.user.id,
        organizationId: request.organizationId,
      });
      if (owned) {
        return reply.send({
          ...owned,
          viewerRole: "owner" as const,
          startupProgress: await inspectStartupProgress(owned),
        });
      }

      // Non-owners may still open the run read-only when a share grants
      // them access. Attaching interactively stays owner-only (enforced in the
      // WebSocket attach handler) because attach runs under the owner's
      // credentials; a share only unlocks the log stream.
      const shared = await AgentRunModel.findSessionByTaskId({
        taskId: request.params.taskId,
        organizationId: request.organizationId,
      });
      if (shared) {
        const explicitlyShared =
          await AgentRunShareModel.findAccessibleByTaskId({
            taskId: request.params.taskId,
            organizationId: request.organizationId,
            userId: request.user.id,
          });
        const sharedThroughProject = shared.projectId
          ? await mayReadProjectSession({
              projectId: shared.projectId,
              organizationId: request.organizationId,
              userId: request.user.id,
            })
          : false;
        if (explicitlyShared || sharedThroughProject) {
          return reply.send({
            ...shared,
            viewerRole: "shared" as const,
            startupProgress: null,
          });
        }
      }

      throw new ApiError(404, "Run not found");
    },
  );

  fastify.patch(
    "/api/agent-runs/:taskId",
    {
      schema: {
        operationId: RouteId.UpdateAgentRun,
        description: "Update one Agent Runtime started by this user",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        body: UpdateAgentRunSchema,
        response: constructResponseSchema(SelectAgentRunSessionSchema),
      },
    },
    async (request, reply) => {
      const run = await requireOwnedRun(request);
      request.auditResourceId = { value: run.taskId };
      request.auditBefore = {
        taskId: run.taskId,
        agentId: run.agentId,
        title: run.title,
        pinnedAt: run.pinnedAt,
        projectId: run.projectId,
      };
      if (request.body.projectId) {
        await requireReadableProject({
          projectId: request.body.projectId,
          organizationId: request.organizationId,
          userId: request.user.id,
        });
      }
      const updated = await AgentRunModel.updateForActor({
        taskId: run.taskId,
        actorUserId: request.user.id,
        organizationId: request.organizationId,
        title: request.body.title,
        pinnedAt:
          request.body.pinnedAt === undefined
            ? undefined
            : request.body.pinnedAt === null
              ? null
              : new Date(request.body.pinnedAt),
        projectId: request.body.projectId,
      });
      if (!updated) throw new ApiError(404, "Run not found");
      request.auditAfter = {
        taskId: updated.taskId,
        agentId: updated.agentId,
        title: updated.title,
        pinnedAt: updated.pinnedAt,
        projectId: updated.projectId,
      };
      return reply.send(updated);
    },
  );

  fastify.post(
    "/api/agent-runs/:taskId/cancel",
    {
      schema: {
        operationId: RouteId.CancelAgentRun,
        description:
          "Cancel one active Agent Runtime session started by this user",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        response: constructResponseSchema(
          z.object({
            taskId: z.string().uuid(),
            state: z.literal("TASK_STATE_CANCELED"),
          }),
        ),
      },
    },
    async (request, reply) => {
      const run = await requireOwnedRun(request);
      request.auditResourceId = { value: run.taskId };
      request.auditBefore = {
        taskId: run.taskId,
        agentId: run.agentId,
        state: run.state,
      };

      const canceled = await cancelDetachedAgentTask({
        actor: {
          id: request.user.id,
          kind: "user",
          organizationId: request.organizationId,
        },
        agentId: run.agentId,
        taskId: run.taskId,
      });
      request.auditAfter = {
        taskId: run.taskId,
        agentId: run.agentId,
        state: canceled.status.state,
      };
      return reply.send({
        taskId: run.taskId,
        state: "TASK_STATE_CANCELED" as const,
      });
    },
  );

  fastify.delete(
    "/api/agent-runs/:taskId",
    {
      schema: {
        operationId: RouteId.DeleteAgentRun,
        description:
          "Delete one finished Agent Runtime session started by this user",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        response: constructResponseSchema(
          z.object({ deleted: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      const run = await requireOwnedRun(request);
      if (!run.endedAt) {
        throw new ApiError(409, "Stop the run before deleting it");
      }
      request.auditResourceId = { value: run.taskId };
      request.auditBefore = {
        taskId: run.taskId,
        agentId: run.agentId,
        title: run.title,
        state: run.state,
      };
      await A2ATaskModel.delete(run.taskId);
      request.auditAfter = { deleted: true };
      return reply.send({ deleted: true as const });
    },
  );

  fastify.get(
    "/api/agent-runs/:taskId/share",
    {
      schema: {
        operationId: RouteId.GetAgentRunShare,
        description: "Get share status for an Agent Runtime run",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        response: constructResponseSchema(
          SelectAgentRunShareWithTargetsSchema.nullable(),
        ),
      },
    },
    async (request, reply) => {
      // Only the owner may read or change share settings.
      await requireOwnedRun(request);
      const share = await AgentRunShareModel.findByTaskId({
        taskId: request.params.taskId,
        organizationId: request.organizationId,
      });
      return reply.send(share);
    },
  );

  fastify.put(
    "/api/agent-runs/:taskId/share",
    {
      schema: {
        operationId: RouteId.ShareAgentRun,
        description:
          "Share an Agent Runtime run with your organization, specific teams, or specific users",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        body: z
          .object({
            visibility: AgentRunShareVisibilitySchema,
            teamIds: z.array(z.string()).optional(),
            userIds: z.array(z.string()).optional(),
          })
          .superRefine((value, ctx) => {
            if (
              value.visibility === "team" &&
              (value.teamIds ?? []).length === 0
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Select at least one team",
                path: ["teamIds"],
              });
            }

            if (
              value.visibility === "user" &&
              (value.userIds ?? []).length === 0
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Select at least one user",
                path: ["userIds"],
              });
            }
          }),
        response: constructResponseSchema(SelectAgentRunShareWithTargetsSchema),
      },
    },
    async (request, reply) => {
      const run = await requireOwnedRun(request);
      request.auditResourceId = { value: run.taskId };
      request.auditBefore = await AgentRunShareModel.findByTaskId({
        taskId: run.taskId,
        organizationId: request.organizationId,
      });

      const teamIds = Array.from(new Set(request.body.teamIds ?? []));
      const userIds = Array.from(new Set(request.body.userIds ?? []));

      if (request.body.visibility === "team") {
        const teams = await TeamModel.findByIds(teamIds);
        const validTeamIds = new Set(
          teams
            .filter((team) => team.organizationId === request.organizationId)
            .map((team) => team.id),
        );
        if (validTeamIds.size !== teamIds.length) {
          throw new ApiError(400, "One or more selected teams are invalid");
        }
      }

      if (request.body.visibility === "user") {
        const validUserIds = new Set(
          await MemberModel.findUserIdsInOrganization({
            organizationId: request.organizationId,
            userIds,
          }),
        );
        if (validUserIds.size !== userIds.length) {
          throw new ApiError(400, "One or more selected users are invalid");
        }
      }

      const share = await AgentRunShareModel.upsert({
        taskId: run.taskId,
        organizationId: request.organizationId,
        createdByUserId: request.user.id,
        visibility: request.body.visibility,
        teamIds: request.body.visibility === "team" ? teamIds : [],
        userIds: request.body.visibility === "user" ? userIds : [],
      });
      request.auditAfter = share;
      return reply.send(share);
    },
  );

  fastify.delete(
    "/api/agent-runs/:taskId/share",
    {
      schema: {
        operationId: RouteId.UnshareAgentRun,
        description: "Revoke sharing of an Agent Runtime run",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      const run = await requireOwnedRun(request);
      request.auditResourceId = { value: run.taskId };
      request.auditBefore = await AgentRunShareModel.findByTaskId({
        taskId: run.taskId,
        organizationId: request.organizationId,
      });

      const deleted = await AgentRunShareModel.delete({
        taskId: run.taskId,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      if (!deleted) {
        throw new ApiError(404, "Share not found");
      }
      request.auditAfter = { success: true };
      return reply.send({ success: true });
    },
  );
};

export default agentRuntimeRoutes;

// ===================== internals =====================

type AgentRequest = {
  params: { id: string };
  user: { id: string };
  organizationId: string;
};

type OwnedRunRequest = {
  params: { taskId: string };
  user: { id: string };
  organizationId: string;
};

async function inspectStartupProgress(
  run: AgentRunSession,
): Promise<AgentRunStartupProgress | null> {
  if (run.endedAt || run.lastModelActivityAt) return null;

  try {
    return await resolveAgentRuntimeBackendDriver(
      run.backend,
    ).getStartupProgress(run);
  } catch (error) {
    // Run metadata remains useful even when the runtime control plane cannot
    // be inspected. The live attach path may still recover independently.
    logger.warn(
      { error, taskId: run.taskId },
      "Could not inspect Agent Runtime startup progress",
    );
    return null;
  }
}

async function requireOwnedRun(request: OwnedRunRequest) {
  const run = await AgentRunModel.findForActorByTaskId({
    taskId: request.params.taskId,
    actorUserId: request.user.id,
    organizationId: request.organizationId,
  });
  if (!run) throw new ApiError(404, "Run not found");
  return run;
}

async function requireReadableProject(params: {
  projectId: string;
  organizationId: string;
  userId: string;
}) {
  const project = await ProjectModel.findById(params.projectId);
  if (
    !project ||
    !(await ProjectShareModel.userCanAccessProject({
      project,
      userId: params.userId,
      organizationId: params.organizationId,
    }))
  ) {
    throw new ApiError(404, "Project not found");
  }
  return project;
}

async function mayReadProjectSession(params: {
  projectId: string;
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  const project = await ProjectModel.findById(params.projectId);
  if (
    !project ||
    !(await ProjectShareModel.userCanAccessProject({
      project,
      userId: params.userId,
      organizationId: params.organizationId,
    }))
  ) {
    return false;
  }
  return userHasPermission(
    params.userId,
    params.organizationId,
    "project",
    "read-all",
  );
}

async function requireReadableAgentRuntimeOnly(
  request: AgentRequest,
): Promise<ResolvedAgentRuntime> {
  return (await requireReadableAgentRuntime(request)).runtime;
}

async function requireReadableAgentRuntime(
  request: AgentRequest,
): Promise<{ agent: Agent; runtime: ResolvedAgentRuntime }> {
  if (!isAnyAgentRuntimeBackendDriverEnabled()) {
    throw new ApiError(404, "Not found");
  }
  const agent = await requireReadableAgent(request);
  const runtime = resolveAgentRuntime(agent);
  if (!runtime) {
    throw new ApiError(404, "Agent Runtime is not configured");
  }
  resolveAgentRuntimeBackendDriver(runtime.backend);
  return { agent, runtime };
}

async function requireReadableAgent(request: AgentRequest): Promise<Agent> {
  const candidate = await AgentModel.findById(
    request.params.id,
    request.user.id,
    true,
  );
  if (
    !candidate ||
    candidate.organizationId !== request.organizationId ||
    candidate.agentType !== "agent"
  ) {
    throw new ApiError(404, "Agent not found");
  }
  const checker = await getAgentTypePermissionChecker({
    userId: request.user.id,
    organizationId: request.organizationId,
  });
  try {
    checker.require("agent", "read");
  } catch {
    throw new ApiError(404, "Agent not found");
  }
  if (!checker.isAdmin("agent")) {
    const visible = await AgentModel.findById(
      request.params.id,
      request.user.id,
      false,
    );
    if (!visible) throw new ApiError(404, "Agent not found");
  }
  return candidate;
}

async function requireWritableAgent(params: {
  request: AgentRequest;
  agent: Agent;
}): Promise<void> {
  const checker = await getAgentTypePermissionChecker({
    userId: params.request.user.id,
    organizationId: params.request.organizationId,
  });
  checker.require("agent", "update");
  const userTeamIds = checker.isAdmin("agent")
    ? []
    : await TeamModel.getUserTeamIds(params.request.user.id);
  requireAgentModifyPermission({
    checker,
    agentType: "agent",
    agentScope: params.agent.scope,
    agentAuthorId: params.agent.authorId,
    agentTeamIds: params.agent.teams.map((team) => team.id),
    userTeamIds,
    userId: params.request.user.id,
  });
}

async function requireRuntimeCredentialAdmin(
  request: AgentRequest,
): Promise<void> {
  const permitted = await userHasPermission(
    request.user.id,
    request.organizationId,
    "agentSettings",
    "update",
  );
  if (!permitted) {
    throw new ApiError(
      403,
      "Organization Agent settings permission is required to manage this connection",
    );
  }
}

function requireCredentialDeclaration(
  runtime: ResolvedAgentRuntime,
  key: string,
): NonNullable<ResolvedAgentRuntime["credentials"]>[number] {
  const declaration = runtime.credentials?.find((entry) => entry.key === key);
  if (!declaration) {
    throw new ApiError(
      404,
      "Credential is not declared by this Agent's Agent Runtime configuration",
    );
  }
  return declaration;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}
