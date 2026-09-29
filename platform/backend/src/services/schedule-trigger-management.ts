import type { z } from "zod";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import { AgentModel, AgentTeamModel, ScheduleTriggerModel } from "@/models";
import { ApiError, ScheduleTriggerConfigurationSchema } from "@/types";
import type {
  CreateScheduleTriggerBodySchema,
  UpdateScheduleTriggerBodySchema,
} from "@/types/schedule-trigger-input";
import { projectService } from "./project";
import { findAccessibleScheduleTriggerOrThrow } from "./schedule-trigger-access";

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
    access: "mutate",
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
