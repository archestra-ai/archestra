import { PROJECT_INSTRUCTIONS_MAX_LENGTH } from "@archestra/shared";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission, userHasPermission } from "@/auth";
import logger from "@/logging";
import { AgentModel, AgentTeamModel, ScheduleTriggerModel } from "@/models";
import {
  ApiError,
  type Project,
  type ScheduleTrigger,
  ScheduleTriggerConfigurationSchema,
} from "@/types";
import type {
  CreateScheduleTriggerBodySchema,
  UpdateScheduleTriggerBodySchema,
} from "@/types/schedule-trigger-input";
import {
  normalizeCronExpression,
  normalizeTimezone,
} from "@/utils/schedule-trigger";
import { projectService } from "./project";
import { findAccessibleScheduleTriggerOrThrow } from "./schedule-trigger-access";

/** The chat/ChatOps shortcut: a private project supplies instructions and run history. */
export async function createScheduleTriggerWithProject(params: {
  body: Omit<
    z.infer<typeof CreateScheduleTriggerBodySchema>,
    "projectId" | "agentId"
  > & { agentId: string };
  userId: string;
  organizationId: string;
}): Promise<{ trigger: ScheduleTrigger; created: boolean }> {
  const { body, userId, organizationId } = params;
  if (!(await userHasPermission(userId, organizationId, "project", "create"))) {
    throw new ApiError(
      403,
      "Creating a scheduled project requires project:create.",
    );
  }
  // Validate before creating anything. The project service validates the name
  // and selected agent before inserting its private, caller-owned project.
  ScheduleTriggerConfigurationSchema.parse(body);
  z.string().max(PROJECT_INSTRUCTIONS_MAX_LENGTH).parse(body.messageTemplate);
  let project: Project;
  try {
    project = await projectService.create({
      organizationId,
      userId,
      name: body.name,
      description: null,
      defaultAgentId: body.agentId,
    });
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 409) {
      // The owner/name unique constraint also serializes concurrent retries.
      // Reuse only the exact private task; never change a conflicting project.
      const existing = await findMatchingScheduledProject(params);
      if (existing) return { trigger: existing, created: false };
    }
    throw error;
  }
  try {
    await projectService.setInstructions({
      id: project.id,
      organizationId,
      userId,
      content: body.messageTemplate,
    });
    // Only publish an enabled trigger after its instructions are ready.
    const trigger = await createScheduleTrigger({
      organizationId,
      userId,
      body: { ...body, projectId: project.id },
    });
    return { trigger, created: true };
  } catch (error) {
    // Use the normal recoverable project deletion path, which also pauses any
    // trigger persisted before an interrupted create. Existing projects never
    // enter this path.
    try {
      await projectService.delete({ id: project.id, organizationId, userId });
    } catch (cleanupError) {
      logger.error(
        { err: cleanupError, projectId: project.id },
        "Failed to discard a new scheduled project after creation failed",
      );
    }
    throw error;
  }
}

export async function createScheduleTrigger(params: {
  body: z.infer<typeof CreateScheduleTriggerBodySchema>;
  userId: string;
  organizationId: string;
}) {
  const { body, userId, organizationId } = params;
  const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
    userId,
    organizationId,
  });

  // projectId is required by the schema; verify the caller can access it.
  // Resolved first because the project's pinned agent outranks the org
  // default for a caller who did not (or could not) pick one.
  const projectId = body.projectId;
  const project = await projectService.get({
    id: projectId,
    organizationId,
    userId,
  });

  // A caller who can pick an agent (`agent:read`) passes one and we verify
  // access; a caller who can't (e.g. a basic-user role) omits it and we fall
  // back to the project's default agent, then the org's.
  let agentId: string;
  if (body.agentId) {
    const agent = await AgentModel.findById(body.agentId, userId, isAgentAdmin);
    if (!agent) {
      throw new ApiError(403, "You do not have access to the selected agent");
    }
    if (
      agent.organizationId !== organizationId ||
      agent.agentType !== "agent"
    ) {
      throw new ApiError(400, "Scheduled triggers require an internal agent");
    }
    agentId = agent.id;
  } else if (project.defaultAgent) {
    // Already re-validated as a live, org-scoped chat agent by the read.
    agentId = project.defaultAgent.id;
  } else {
    const defaultAgent = await AgentModel.findDefaultByType({
      organizationId,
      agentType: "agent",
    });
    if (!defaultAgent) {
      throw new ApiError(
        400,
        "No default agent is configured for scheduled tasks",
      );
    }
    agentId = defaultAgent.id;
  }

  const trigger = await ScheduleTriggerModel.create({
    organizationId,
    name: body.name,
    agentId,
    projectId,
    messageTemplate: body.messageTemplate,
    cronExpression: body.cronExpression,
    timezone: body.timezone,
    enabled: body.enabled ?? true,
    actorUserId: userId,
  });

  return trigger;
}

export async function updateScheduleTrigger(params: {
  id: string;
  body: z.infer<typeof UpdateScheduleTriggerBodySchema>;
  userId: string;
  organizationId: string;
}) {
  const { id, body, userId, organizationId } = params;
  const existing = await findAccessibleScheduleTriggerOrThrow({
    id,
    userId,
    organizationId,
    access: "update",
  });
  const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
    userId,
    organizationId,
  });

  // Only validate the agent when the caller is actually changing it. A
  // caller without `agent:read` editing other fields omits agentId and must
  // not be access-checked against the trigger's existing (default) agent.
  if (body.agentId !== undefined && body.agentId !== existing.agentId) {
    const agent = await AgentModel.findById(body.agentId, userId, isAgentAdmin);
    if (!agent) {
      throw new ApiError(403, "You do not have access to the selected agent");
    }
    if (
      agent.organizationId !== organizationId ||
      agent.agentType !== "agent"
    ) {
      throw new ApiError(400, "Scheduled triggers require an internal agent");
    }

    const actorIsAgentAdmin = await hasAnyAgentTypeAdminPermission({
      userId: existing.actorUserId,
      organizationId,
    });
    const actorHasAgentAccess = await AgentTeamModel.userHasAgentAccess({
      userId: existing.actorUserId,
      agentId: body.agentId,
      isAgentAdmin: actorIsAgentAdmin,
      action: "use",
    });
    if (!actorHasAgentAccess) {
      throw new ApiError(
        400,
        "The stored trigger actor must have access to the selected agent",
      );
    }
  }

  const cronExpression = body.cronExpression ?? existing.cronExpression;
  const timezone = body.timezone ?? existing.timezone;
  const messageTemplate = body.messageTemplate ?? existing.messageTemplate;
  const validation = ScheduleTriggerConfigurationSchema.safeParse({
    cronExpression,
    timezone,
    messageTemplate,
  });
  if (!validation.success) {
    const firstIssue = validation.error.issues[0];
    throw new ApiError(
      400,
      firstIssue?.message ?? "Invalid schedule trigger configuration",
    );
  }

  // Guard project re-scoping: only to a project the caller can access.
  if (body.projectId !== undefined) {
    await projectService.get({
      id: body.projectId,
      organizationId,
      userId,
    });
  }

  const updated = await ScheduleTriggerModel.update(id, body);

  if (!updated) {
    throw new ApiError(404, "Schedule trigger not found");
  }

  return updated;
}

async function findMatchingScheduledProject(
  params: Parameters<typeof createScheduleTriggerWithProject>[0],
): Promise<ScheduleTrigger | null> {
  const { body, organizationId, userId } = params;
  const { data: projects } = await projectService.list({
    organizationId,
    userId,
    search: body.name,
  });
  const project = projects.find(
    (candidate) =>
      candidate.name === body.name.trim() &&
      candidate.viewerRole === "owner" &&
      candidate.visibility === null,
  );
  if (!project) return null;
  const { content } = await projectService.getInstructions({
    id: project.id,
    organizationId,
    userId,
  });
  if (content !== body.messageTemplate) return null;
  const triggers = await ScheduleTriggerModel.listByOrganization({
    organizationId,
    projectId: project.id,
    actorUserId: userId,
    limit: 2,
  });
  const [trigger] = triggers;
  return triggers.length === 1 &&
    trigger.agentId === body.agentId &&
    trigger.name === body.name &&
    trigger.messageTemplate === body.messageTemplate &&
    trigger.cronExpression === normalizeCronExpression(body.cronExpression) &&
    trigger.timezone === normalizeTimezone(body.timezone) &&
    trigger.enabled === (body.enabled ?? true)
    ? trigger
    : null;
}
