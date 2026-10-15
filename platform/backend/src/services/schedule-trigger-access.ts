import logger from "@/logging";
import {
  ProjectAccessModel,
  ProjectModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";
import type { ScheduleTrigger, ScheduleTriggerRun } from "@/types";
import { ApiError } from "@/types";
import { ResourcePermissions } from "./resource-permissions";

// === Exports ===

/**
 * The single authorization gate for one schedule trigger, shared by the REST
 * routes and the built-in MCP tools so the two surfaces cannot drift apart.
 */
export async function findAccessibleScheduleTriggerOrThrow(params: {
  id: string;
  userId: string;
  organizationId: string;
  access: ScheduleTriggerAccess;
}): Promise<ScheduleTrigger> {
  const trigger = await ScheduleTriggerModel.findById(params.id);
  if (!trigger || trigger.organizationId !== params.organizationId) {
    throw new ApiError(404, "Schedule trigger not found");
  }

  // A trigger of a soft-deleted project is hidden and paused with it — 404 for
  // everyone (actor and project oversight included), or run-now could still
  // execute into the hidden project past the due-picker's pause. `findById`
  // excludes soft-deleted projects, so a retained trigger resolves to no project.
  const project = trigger.projectId
    ? await ProjectModel.findById(trigger.projectId)
    : null;
  if (trigger.projectId && !project) {
    throw new ApiError(404, "Schedule trigger not found");
  }

  // The actor the trigger runs as always has access
  if (trigger.actorUserId === params.userId) {
    return trigger;
  }

  // Organization-wide project oversight reaches schedules too. A read grant
  // permits inspection only; writes and execution need their own action.
  // A grant on one shared project never permits acting as another user.
  if (
    await hasProjectScheduleOversight({
      userId: params.userId,
      organizationId: params.organizationId,
      action: params.access,
    })
  ) {
    return trigger;
  }

  // Project members may READ the schedules of a project they can access (and
  // their runs). Reuses the same ProjectAccessModel.userCanAccessProject check
  // that backs GET /api/projects/:id (via projectService.requireViewable).
  // Deliberately read-only — see ScheduleTriggerAccess.
  if (params.access === "read" && project) {
    if (
      await ProjectAccessModel.userCanAccessProject({
        project,
        userId: params.userId,
        organizationId: params.organizationId,
      })
    ) {
      return trigger;
    }
  }

  throw new ApiError(403, "You do not have access to this scheduled task");
}

/** Authorizes the trigger first, then resolves one of its runs. */
export async function findAccessibleScheduleTriggerRunOrThrow(params: {
  triggerId: string;
  runId: string;
  userId: string;
  organizationId: string;
  access: ScheduleTriggerAccess;
}): Promise<ScheduleTriggerRun> {
  await findAccessibleScheduleTriggerOrThrow({
    id: params.triggerId,
    userId: params.userId,
    organizationId: params.organizationId,
    access: params.access,
  });

  const run = await ScheduleTriggerRunModel.findById(params.runId);
  if (
    !run ||
    run.organizationId !== params.organizationId ||
    run.triggerId !== params.triggerId
  ) {
    throw new ApiError(404, "Schedule trigger run not found");
  }

  return run;
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Whether organization-wide Projects authority reaches this schedule action.
 */
export async function hasProjectScheduleOversight(params: {
  userId: string;
  organizationId: string;
  action?: ScheduleTriggerAccess;
}): Promise<boolean> {
  return await ResourcePermissions.allows({
    userId: params.userId,
    organizationId: params.organizationId,
    resource: "project",
    scope: "*",
    action: params.action ?? "read",
  });
}
// SPDX-SnippetEnd

/**
 * Records a manual run and queues its execution. Callers authorize first
 * (`access: "use"`); this only performs the side effect.
 */
export async function startManualScheduleTriggerRun(params: {
  trigger: ScheduleTrigger;
  initiatedByUserId: string;
}): Promise<ScheduleTriggerRun> {
  const run = await ScheduleTriggerRunModel.createManualRun({
    trigger: params.trigger,
    initiatedByUserId: params.initiatedByUserId,
  });

  await taskQueueService.enqueue({
    taskType: "schedule_trigger_run_execute",
    payload: { runId: run.id, triggerId: params.trigger.id },
  });

  logger.info(
    {
      runId: run.id,
      triggerId: params.trigger.id,
      userId: params.initiatedByUserId,
    },
    "Manual schedule trigger run created",
  );

  return run;
}

// === Internal helpers ===

/**
 * How much authority an operation needs over a trigger.
 *
 * `read` — viewing the trigger and its runs. Project members qualify, so a
 * project's schedules are visible to everyone who can see the project.
 *
 * `update`, `delete`, `use` — changing the trigger or executing it (update,
 * delete, enable/disable, run-now, minting a run conversation). Project
 * membership is NOT enough: a scheduled run executes as `trigger.actorUserId`
 * against that actor's agent and credentials, so letting a project member
 * rewrite or fire another member's schedule would let them act as that actor.
 * Restricted to the actor themselves or the corresponding organization-wide Project grant.
 */
type ScheduleTriggerAccess = "read" | "update" | "delete" | "use";
