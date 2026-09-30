import { getArchestraToolFullName } from "@archestra/shared";
import {
  ConversationModel,
  InteractionModel,
  MemberModel,
  MessageModel,
  ScheduleTriggerRunModel,
  TaskModel,
} from "@/models";
import AuditLogModel from "@/models/audit-log";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import { projectService } from "@/services/project";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import { type ArchestraContext, executeArchestraTool } from ".";
import { filterToolNamesByPermission } from "./rbac";

const LIST_TRIGGERS = getArchestraToolFullName("list_schedule_triggers");
const GET_TRIGGER = getArchestraToolFullName("get_schedule_trigger");
const LIST_RUNS = getArchestraToolFullName("list_schedule_trigger_runs");
const GET_RUN = getArchestraToolFullName("get_schedule_trigger_run");
const GET_TRANSCRIPT = getArchestraToolFullName(
  "get_schedule_trigger_run_transcript",
);
const DISABLE_TRIGGER = getArchestraToolFullName("disable_schedule_trigger");
const ENABLE_TRIGGER = getArchestraToolFullName("enable_schedule_trigger");
const RUN_NOW = getArchestraToolFullName("run_schedule_trigger_now");

const textOf = (result: { content: unknown[] }) =>
  (result.content[0] as { text: string }).text;

describe("schedule trigger MCP tools", () => {
  let agent: Agent;
  let userId: string;
  let organizationId: string;
  let context: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    organizationId = org.id;
    userId = user.id;
    agent = await makeAgent({ organizationId, agentType: "agent" });
    context = {
      agent: { id: agent.id, name: agent.name },
      userId,
      organizationId,
    };
  });

  async function createProjectSchedule(
    overrides: Record<string, unknown> = {},
  ) {
    const project = await projectService.create({
      organizationId,
      userId,
      name: `Weekly reports ${crypto.randomUUID()}`,
      description: null,
    });
    return executeArchestraTool(
      getArchestraToolFullName("create_schedule_trigger"),
      {
        project_id: project.id,
        agent_id: agent.id,
        name: "Weekly report",
        cron_expression: "0 9 * * 1",
        timezone: "America/Toronto",
        message_template: "Summarize the project.",
        ...overrides,
      },
      context,
    );
  }

  test("creates, edits, reads and deletes a project schedule with audited changes", async () => {
    const created = await createProjectSchedule({ enabled: false });
    expect(created.isError, textOf(created)).toBe(false);
    const id = created.structuredContent?.id as string;
    expect(await ScheduleTriggerModel.findById(id)).toMatchObject({
      actorUserId: userId,
      enabled: false,
      cronExpression: "0 9 * * 1",
      timezone: "America/Toronto",
    });
    await drainBackgroundWork();
    const updated = await executeArchestraTool(
      getArchestraToolFullName("update_schedule_trigger"),
      {
        schedule_trigger_id: id,
        name: "Daily report",
        cron_expression: "0 10 * * *",
        message_template: "Summarize today's work.",
      },
      context,
    );
    expect(updated.isError, textOf(updated)).toBe(false);
    expect(updated.structuredContent).toMatchObject({
      name: "Daily report",
      enabled: false,
      timezone: "America/Toronto",
    });
    const read = await executeArchestraTool(
      GET_TRIGGER,
      { schedule_trigger_id: id },
      context,
    );
    expect(read.structuredContent).toMatchObject({
      message_template: "Summarize today's work.",
      cron_expression: "0 10 * * *",
    });
    await drainBackgroundWork();
    const deleted = await executeArchestraTool(
      getArchestraToolFullName("delete_schedule_trigger"),
      { schedule_trigger_id: id },
      context,
    );
    expect(deleted.isError, textOf(deleted)).toBe(false);
    expect(await ScheduleTriggerModel.findById(id)).toBeNull();
    await drainBackgroundWork();
    const { data: audit } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "scheduleTrigger",
      limit: 20,
      offset: 0,
    });
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "scheduleTrigger.created",
          resourceId: id,
          before: null,
          after: expect.objectContaining({ enabled: false }),
        }),
        expect.objectContaining({
          action: "scheduleTrigger.updated",
          resourceId: id,
          before: expect.objectContaining({ name: "Weekly report" }),
          after: expect.objectContaining({ name: "Daily report" }),
        }),
        expect.objectContaining({
          action: "scheduleTrigger.deleted",
          resourceId: id,
          before: expect.objectContaining({ name: "Daily report" }),
          after: null,
        }),
      ]),
    );
  });

  test("uses the project's default agent when creation omits agent_id", async () => {
    const project = await projectService.create({
      organizationId,
      userId,
      name: "Pinned agent",
      description: null,
      defaultAgentId: agent.id,
    });
    const result = await executeArchestraTool(
      getArchestraToolFullName("create_schedule_trigger"),
      {
        project_id: project.id,
        name: "Report",
        cron_expression: "0 9 * * *",
        timezone: "UTC",
        message_template: "Report.",
      },
      context,
    );
    expect(result.isError, textOf(result)).toBe(false);
    expect(result.structuredContent).toMatchObject({
      agent_id: agent.id,
      enabled: true,
      actor_user_id: userId,
    });
  });

  test("rejects invalid cron, timezone, missing project and empty updates without persisting changes", async () => {
    for (const override of [
      { cron_expression: "invalid" },
      { timezone: "Invalid/Zone" },
      { project_id: undefined },
      { message_template: "" },
    ]) {
      const result = await createProjectSchedule(override);
      expect(result.isError).toBe(true);
    }
    expect(
      await ScheduleTriggerModel.listByOrganization({ organizationId }),
    ).toEqual([]);
    const created = await createProjectSchedule();
    const id = created.structuredContent?.id as string;
    for (const changes of [
      {},
      { cron_expression: "invalid" },
      { timezone: "Invalid/Zone" },
      { actor_user_id: "someone-else" },
    ]) {
      const result = await executeArchestraTool(
        getArchestraToolFullName("update_schedule_trigger"),
        { schedule_trigger_id: id, ...changes },
        context,
      );
      expect(result.isError).toBe(true);
    }
    expect(await ScheduleTriggerModel.findById(id)).toMatchObject({
      cronExpression: "0 9 * * 1",
      actorUserId: userId,
    });
  });

  test("rejects inaccessible projects and agents on create and update", async ({
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const other = await makeUser();
    await makeMember(other.id, organizationId, { role: "member" });
    const privateProject = await projectService.create({
      organizationId,
      userId: other.id,
      name: "Private",
      description: null,
    });
    const privateAgent = await makeAgent({
      organizationId,
      agentType: "agent",
      authorId: other.id,
      access: "personal",
    });
    const created = await createProjectSchedule();
    const id = created.structuredContent?.id as string;
    for (const override of [
      { project_id: privateProject.id },
      { agent_id: privateAgent.id },
    ]) {
      expect((await createProjectSchedule(override)).isError).toBe(true);
      expect(
        (
          await executeArchestraTool(
            getArchestraToolFullName("update_schedule_trigger"),
            { schedule_trigger_id: id, ...override },
            context,
          )
        ).isError,
      ).toBe(true);
    }
  });

  test("project access does not allow editing, deleting or running another actor's schedule", async ({
    makeUser,
    makeMember,
    makeScheduleTrigger,
  }) => {
    const other = await makeUser();
    await makeMember(other.id, organizationId, { role: "member" });
    const project = await projectService.create({
      organizationId,
      userId,
      name: "Shared reports",
      description: null,
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: other.id,
      agentId: agent.id,
      projectId: project.id,
    });
    for (const name of [
      "update_schedule_trigger",
      "delete_schedule_trigger",
      "run_schedule_trigger_now",
      "enable_schedule_trigger",
      "disable_schedule_trigger",
    ] as const) {
      const result = await executeArchestraTool(
        getArchestraToolFullName(name),
        {
          schedule_trigger_id: trigger.id,
          ...(name === "update_schedule_trigger" ? { name: "Changed" } : {}),
        },
        context,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("do not have access");
    }
    expect(
      await ScheduleTriggerRunModel.listByTrigger({
        organizationId,
        triggerId: trigger.id,
      }),
    ).toEqual([]);
    expect(await ScheduleTriggerModel.findById(trigger.id)).toMatchObject({
      name: trigger.name,
    });
  });

  test("read-only RBAC denies every mutation including creation", async ({
    makeCustomRole,
  }) => {
    const created = await createProjectSchedule();
    const id = created.structuredContent?.id as string;
    const role = await makeCustomRole(organizationId, {
      permission: { scheduledTask: ["read"] },
    });
    await MemberModel.updateRole(userId, organizationId, role.role);
    for (const name of [
      "create_schedule_trigger",
      "update_schedule_trigger",
      "delete_schedule_trigger",
      "enable_schedule_trigger",
      "disable_schedule_trigger",
      "run_schedule_trigger_now",
    ] as const) {
      const result = await executeArchestraTool(
        getArchestraToolFullName(name),
        { schedule_trigger_id: id, name: "Changed" },
        context,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/permission/i);
    }
  });

  test("hides mutations from tool discovery for a read-only role", async ({
    makeCustomRole,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { scheduledTask: ["read"] },
    });
    await MemberModel.updateRole(userId, organizationId, role.role);
    const readTools = [LIST_TRIGGERS, GET_TRIGGER, LIST_RUNS, GET_RUN];
    const available = await filterToolNamesByPermission(
      [
        ...readTools,
        ENABLE_TRIGGER,
        DISABLE_TRIGGER,
        RUN_NOW,
        getArchestraToolFullName("create_schedule_trigger"),
        getArchestraToolFullName("update_schedule_trigger"),
        getArchestraToolFullName("delete_schedule_trigger"),
      ],
      userId,
      organizationId,
    );
    expect([...available].sort()).toEqual(readTools.sort());
  });

  test("requires a user identity and hides deleted-project schedules from reads and writes", async () => {
    const created = await createProjectSchedule();
    const id = created.structuredContent?.id as string;
    const projectId = created.structuredContent?.project_id as string;
    const anonymous = await executeArchestraTool(
      LIST_TRIGGERS,
      {},
      { ...context, userId: undefined },
    );
    expect(anonymous.isError).toBe(true);
    await projectService.delete({ id: projectId, organizationId, userId });
    for (const name of [
      GET_TRIGGER,
      LIST_RUNS,
      RUN_NOW,
      ENABLE_TRIGGER,
      DISABLE_TRIGGER,
      getArchestraToolFullName("update_schedule_trigger"),
      getArchestraToolFullName("delete_schedule_trigger"),
    ]) {
      const result = await executeArchestraTool(
        name,
        {
          schedule_trigger_id: id,
          ...(name === getArchestraToolFullName("update_schedule_trigger")
            ? { name: "Changed" }
            : {}),
        },
        context,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not found");
    }
    const listed = await executeArchestraTool(LIST_TRIGGERS, {}, context);
    expect(listed.structuredContent).toMatchObject({ schedule_triggers: [] });
  });

  test("organization boundaries apply to every mutation", async ({
    makeScheduleTrigger,
  }) => {
    const foreign = await makeScheduleTrigger();
    for (const name of [
      ENABLE_TRIGGER,
      DISABLE_TRIGGER,
      RUN_NOW,
      getArchestraToolFullName("update_schedule_trigger"),
      getArchestraToolFullName("delete_schedule_trigger"),
    ]) {
      const result = await executeArchestraTool(
        name,
        {
          schedule_trigger_id: foreign.id,
          ...(name === getArchestraToolFullName("update_schedule_trigger")
            ? { name: "Changed" }
            : {}),
        },
        context,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not found");
    }
    expect(await ScheduleTriggerModel.findById(foreign.id)).toMatchObject({
      name: foreign.name,
    });
  });

  test("pages past 100 schedules without including new rows or other users' schedules", async ({
    makeScheduleTrigger,
    makeUser,
  }) => {
    const expected: string[] = [];
    for (let i = 0; i < 101; i++) {
      expected.push(
        (
          await makeScheduleTrigger({
            organizationId,
            agentId: agent.id,
            actorUserId: userId,
            enabled: true,
          })
        ).id,
      );
    }
    await makeScheduleTrigger({
      organizationId,
      agentId: agent.id,
      actorUserId: userId,
      enabled: false,
    });
    await makeScheduleTrigger({
      organizationId,
      agentId: agent.id,
      actorUserId: (await makeUser()).id,
      enabled: true,
    });
    const first = await executeArchestraTool(
      LIST_TRIGGERS,
      { enabled: true, limit: 100 },
      context,
    );
    expect(first.isError, textOf(first)).toBe(false);
    const page = first.structuredContent as {
      schedule_triggers: { id: string }[];
      pagination: { nextCursor: string; hasNext: boolean };
    };
    expect(page.schedule_triggers).toHaveLength(100);
    expect(textOf(first)).toContain(page.pagination.nextCursor);
    expect(page.pagination).toMatchObject({
      hasNext: true,
      nextCursor: expect.any(String),
    });
    await makeScheduleTrigger({
      organizationId,
      agentId: agent.id,
      actorUserId: userId,
      enabled: true,
    });
    const second = await executeArchestraTool(
      LIST_TRIGGERS,
      { enabled: true, limit: 100, cursor: page.pagination.nextCursor },
      context,
    );
    expect(second.isError, textOf(second)).toBe(false);
    const last = second.structuredContent as {
      schedule_triggers: { id: string }[];
      pagination: unknown;
    };
    expect(last.schedule_triggers).toHaveLength(1);
    expect(last.pagination).toMatchObject({ hasNext: false, nextCursor: null });
    expect(
      [...page.schedule_triggers, ...last.schedule_triggers]
        .map((row) => row.id)
        .sort(),
    ).toEqual(expected.sort());
  });

  test("pages filtered run history past 100 rows and rechecks access on every page", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeUser,
  }) => {
    const trigger = await makeScheduleTrigger({
      organizationId,
      agentId: agent.id,
      actorUserId: userId,
    });
    const expected: string[] = [];
    for (let i = 0; i < 101; i++)
      expected.push((await makeScheduleTriggerRun(trigger.id)).id);
    const completed = await makeScheduleTriggerRun(trigger.id);
    await ScheduleTriggerRunModel.markCompleted({
      runId: completed.id,
      status: "success",
    });
    const first = await executeArchestraTool(
      LIST_RUNS,
      { schedule_trigger_id: trigger.id, status: "running", limit: 100 },
      context,
    );
    expect(first.isError, textOf(first)).toBe(false);
    const page = first.structuredContent as {
      runs: { id: string }[];
      pagination: { nextCursor: string };
    };
    expect(page.runs).toHaveLength(100);
    expect(textOf(first)).toContain(page.pagination.nextCursor);
    const args = {
      schedule_trigger_id: trigger.id,
      status: "running",
      limit: 100,
      cursor: page.pagination.nextCursor,
    };
    await makeScheduleTriggerRun(trigger.id);
    const second = await executeArchestraTool(LIST_RUNS, args, context);
    expect(second.isError, textOf(second)).toBe(false);
    const last = second.structuredContent as {
      runs: { id: string }[];
      pagination: unknown;
    };
    expect(last.runs).toHaveLength(1);
    expect(last.pagination).toMatchObject({ hasNext: false, nextCursor: null });
    expect([...page.runs, ...last.runs].map((row) => row.id).sort()).toEqual(
      expected.sort(),
    );
    const other = await makeScheduleTrigger({
      organizationId,
      agentId: agent.id,
      actorUserId: (await makeUser()).id,
    });
    const denied = await executeArchestraTool(
      LIST_RUNS,
      { ...args, schedule_trigger_id: other.id },
      context,
    );
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("do not have access");
  });

  test("unusable cursors restart at the newest page and invalid page sizes are rejected", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const trigger = await makeScheduleTrigger({
      organizationId,
      agentId: agent.id,
      actorUserId: userId,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    for (const tool of [LIST_TRIGGERS, LIST_RUNS]) {
      const args =
        tool === LIST_RUNS ? { schedule_trigger_id: trigger.id } : {};
      for (const cursor of [
        "broken",
        Buffer.from(
          JSON.stringify({ id: "not-a-uuid", value: new Date().toISOString() }),
        ).toString("base64url"),
        Buffer.from(
          JSON.stringify({ id: trigger.id, value: "not-a-date" }),
        ).toString("base64url"),
      ]) {
        const result = await executeArchestraTool(
          tool,
          { ...args, cursor },
          context,
        );
        expect(result.isError, textOf(result)).toBe(false);
        expect(result.structuredContent).toMatchObject({
          [tool === LIST_RUNS ? "runs" : "schedule_triggers"]: [
            { id: tool === LIST_RUNS ? run.id : trigger.id },
          ],
          pagination: { hasNext: false, nextCursor: null },
        });
      }
      for (const limit of [0, -1, 1.5, 101]) {
        expect(
          (await executeArchestraTool(tool, { ...args, limit }, context))
            .isError,
        ).toBe(true);
      }
    }
  });

  describe("list_schedule_triggers", () => {
    test("lists the caller's own schedules but not another member's", async ({
      makeScheduleTrigger,
      makeUser,
      makeMember,
    }) => {
      const mine = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
        name: "nightly-dependabot",
      });
      const stranger = await makeUser();
      await makeMember(stranger.id, organizationId, { role: "member" });
      const theirs = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: stranger.id,
      });

      const result = await executeArchestraTool(LIST_TRIGGERS, {}, context);

      expect(result.isError).toBe(false);
      const ids = (
        result.structuredContent as { schedule_triggers: { id: string }[] }
      ).schedule_triggers.map((t) => t.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });

    test("ignores include_all_users for a caller without org-wide access", async ({
      makeScheduleTrigger,
      makeUser,
      makeMember,
    }) => {
      const stranger = await makeUser();
      await makeMember(stranger.id, organizationId, { role: "member" });
      const theirs = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: stranger.id,
      });

      const result = await executeArchestraTool(
        LIST_TRIGGERS,
        { include_all_users: true },
        context,
      );

      expect(result.isError).toBe(false);
      expect(
        (
          result.structuredContent as { schedule_triggers: { id: string }[] }
        ).schedule_triggers.map((t) => t.id),
      ).not.toContain(theirs.id);
    });

    test("an org admin sweeping with include_all_users sees other members' schedules", async ({
      makeScheduleTrigger,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      const admin = await makeUser();
      await makeMember(admin.id, organizationId, { role: "admin" });
      const adminAgent = await makeAgent({
        organizationId,
        agentType: "agent",
      });
      const theirs = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });

      const result = await executeArchestraTool(
        LIST_TRIGGERS,
        { include_all_users: true },
        {
          agent: { id: adminAgent.id, name: adminAgent.name },
          userId: admin.id,
          organizationId,
        },
      );

      expect(result.isError).toBe(false);
      expect(
        (
          result.structuredContent as { schedule_triggers: { id: string }[] }
        ).schedule_triggers.map((t) => t.id),
      ).toContain(theirs.id);
    });

    test("reports the audit fields that reveal a silently skipping schedule", async ({
      makeScheduleTrigger,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
        name: "dependabot-sweep",
        cronExpression: "0 9 * * *",
        timezone: "Europe/Berlin",
        enabled: true,
      });

      const result = await executeArchestraTool(LIST_TRIGGERS, {}, context);

      const row = (
        result.structuredContent as { schedule_triggers: { id: string }[] }
      ).schedule_triggers.find((t) => t.id === trigger.id);
      expect(row).toMatchObject({
        name: "dependabot-sweep",
        agent_id: agent.id,
        agent_name: agent.name,
        cron_expression: "0 9 * * *",
        timezone: "Europe/Berlin",
        enabled: true,
        last_executed_at: null,
      });
    });

    test("filters by enabled state", async ({ makeScheduleTrigger }) => {
      const on = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
        enabled: true,
      });
      const off = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
        enabled: false,
      });

      const result = await executeArchestraTool(
        LIST_TRIGGERS,
        { enabled: false },
        context,
      );

      const ids = (
        result.structuredContent as { schedule_triggers: { id: string }[] }
      ).schedule_triggers.map((t) => t.id);
      expect(ids).toEqual([off.id]);
      expect(ids).not.toContain(on.id);
    });

    test("a project's schedules are visible to a member who can reach the project", async ({
      makeScheduleTrigger,
      makeUser,
      makeMember,
    }) => {
      const owner = await makeUser();
      await makeMember(owner.id, organizationId, { role: "member" });
      const project = await projectService.create({
        organizationId,
        userId,
        name: "shared-automation",
        description: null,
      });
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: owner.id,
        projectId: project.id,
      });

      const result = await executeArchestraTool(
        LIST_TRIGGERS,
        { project_id: project.id },
        context,
      );

      expect(result.isError).toBe(false);
      expect(
        (
          result.structuredContent as { schedule_triggers: { id: string }[] }
        ).schedule_triggers.map((t) => t.id),
      ).toContain(trigger.id);
    });
  });

  describe("get_schedule_trigger", () => {
    test("returns the message template alongside the schedule", async ({
      makeScheduleTrigger,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
        messageTemplate: "Check for new advisories",
      });

      const result = await executeArchestraTool(
        GET_TRIGGER,
        { schedule_trigger_id: trigger.id },
        context,
      );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        id: trigger.id,
        message_template: "Check for new advisories",
      });
    });

    test("refuses another member's schedule", async ({
      makeScheduleTrigger,
      makeUser,
      makeMember,
    }) => {
      const stranger = await makeUser();
      await makeMember(stranger.id, organizationId, { role: "member" });
      const theirs = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: stranger.id,
      });

      const result = await executeArchestraTool(
        GET_TRIGGER,
        { schedule_trigger_id: theirs.id },
        context,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("do not have access");
    });

    test("does not leak a schedule from another organization", async ({
      makeScheduleTrigger,
    }) => {
      const foreign = await makeScheduleTrigger({ actorUserId: userId });

      const result = await executeArchestraTool(
        GET_TRIGGER,
        { schedule_trigger_id: foreign.id },
        context,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Schedule trigger not found");
    });
  });

  describe("run history", () => {
    test("surfaces each run's kind, status and failure text", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });
      const skipped = await makeScheduleTriggerRun(trigger.id, {
        runKind: "due",
      });
      await ScheduleTriggerRunModel.markCompleted({
        runId: skipped.id,
        status: "failed",
        error: "Previous run still in progress",
      });
      await makeScheduleTriggerRun(trigger.id, { runKind: "manual" });

      const result = await executeArchestraTool(
        LIST_RUNS,
        { schedule_trigger_id: trigger.id },
        context,
      );

      expect(result.isError).toBe(false);
      const runs = (
        result.structuredContent as {
          runs: { id: string; completed_at: string | null }[];
        }
      ).runs;
      expect(runs).toHaveLength(2);
      const failed = runs.find((r) => r.id === skipped.id);
      expect(failed).toMatchObject({
        run_kind: "due",
        status: "failed",
        error: "Previous run still in progress",
      });
      expect(failed?.completed_at).not.toBeNull();
    });

    test("filters runs by status", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });
      const failed = await makeScheduleTriggerRun(trigger.id);
      await ScheduleTriggerRunModel.markCompleted({
        runId: failed.id,
        status: "failed",
        error: "boom",
      });
      await makeScheduleTriggerRun(trigger.id);

      const result = await executeArchestraTool(
        LIST_RUNS,
        { schedule_trigger_id: trigger.id, status: "failed" },
        context,
      );

      expect(
        (
          result.structuredContent as {
            runs: { id: string; completed_at: string | null }[];
          }
        ).runs.map((r) => r.id),
      ).toEqual([failed.id]);
    });

    test("get_schedule_trigger_run returns one run's error text", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });
      const run = await makeScheduleTriggerRun(trigger.id);
      await ScheduleTriggerRunModel.markCompleted({
        runId: run.id,
        status: "failed",
        error: "agent unavailable",
      });

      const result = await executeArchestraTool(
        GET_RUN,
        { schedule_trigger_id: trigger.id, run_id: run.id },
        context,
      );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        id: run.id,
        status: "failed",
        error: "agent unavailable",
      });
    });

    test("refuses a run id that belongs to a different schedule", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      const [a, b] = await Promise.all([
        makeScheduleTrigger({
          organizationId,
          agentId: agent.id,
          actorUserId: userId,
        }),
        makeScheduleTrigger({
          organizationId,
          agentId: agent.id,
          actorUserId: userId,
        }),
      ]);
      const run = await makeScheduleTriggerRun(b.id);

      const result = await executeArchestraTool(
        GET_RUN,
        { schedule_trigger_id: a.id, run_id: run.id },
        context,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Schedule trigger run not found");
    });

    test("a project member may read runs of a schedule they do not own", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeUser,
      makeMember,
    }) => {
      const owner = await makeUser();
      await makeMember(owner.id, organizationId, { role: "member" });
      const project = await projectService.create({
        organizationId,
        userId,
        name: "team-automation",
        description: null,
      });
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: owner.id,
        projectId: project.id,
      });
      const run = await makeScheduleTriggerRun(trigger.id);

      const result = await executeArchestraTool(
        LIST_RUNS,
        { schedule_trigger_id: trigger.id },
        context,
      );

      expect(result.isError).toBe(false);
      expect(
        (
          result.structuredContent as {
            runs: { id: string; completed_at: string | null }[];
          }
        ).runs.map((r) => r.id),
      ).toEqual([run.id]);
    });
  });

  describe("run transcript", () => {
    type TranscriptOutput = {
      source: string;
      note: string | null;
      total_messages: number;
      next_offset: number | null;
      messages: {
        role: string;
        parts: {
          type: string;
          text: string | null;
          tool_name: string | null;
          input: string | null;
          output: string | null;
          error: string | null;
          is_error: boolean | null;
        }[];
      }[];
    };

    async function makeRunWithConversation(params: {
      triggerId: string;
      makeScheduleTriggerRun: (triggerId: string) => Promise<{ id: string }>;
    }) {
      const run = await params.makeScheduleTriggerRun(params.triggerId);
      const conversation = await ConversationModel.create({
        userId,
        organizationId,
        agentId: agent.id,
        title: "Weekly report",
        origin: "schedule_trigger",
      });
      await ScheduleTriggerRunModel.setChatConversationId(
        run.id,
        conversation.id,
      );
      // A variable, not an inline literal, so the createdAt passthrough
      // type-checks (as in scheduled-run-conversation.ts).
      const rows = [
        {
          conversationId: conversation.id,
          role: "user",
          content: {
            role: "user",
            parts: [{ type: "text", text: "Post the weekly report." }],
          },
          createdAt: new Date(Date.now() - 1000),
        },
        {
          conversationId: conversation.id,
          role: "assistant",
          content: {
            role: "assistant",
            parts: [
              { type: "step-start" },
              {
                type: "tool-list_files",
                toolCallId: "call-1",
                state: "output-available",
                input: { folder: "reports" },
                output: { files: ["week-39.md"] },
              },
              {
                type: "dynamic-tool",
                toolName: "slack__post_message",
                toolCallId: "call-2",
                state: "output-error",
                input: { channel: "#reports", text: "x".repeat(500) },
                errorText: "channel_not_found",
              },
              { type: "text", text: "Posted the weekly report." },
            ],
          },
          createdAt: new Date(),
        },
      ];
      await MessageModel.bulkCreate(rows);
      await ScheduleTriggerRunModel.markCompleted({
        runId: run.id,
        status: "success",
      });
      return run;
    }

    test("returns a successful run's messages, including a failed tool call", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });
      const run = await makeRunWithConversation({
        triggerId: trigger.id,
        makeScheduleTriggerRun,
      });

      const result = await executeArchestraTool(
        GET_TRANSCRIPT,
        { schedule_trigger_id: trigger.id, run_id: run.id, max_chars: 100 },
        context,
      );

      expect(result.isError, textOf(result)).toBe(false);
      const output = result.structuredContent as TranscriptOutput;
      expect(output).toMatchObject({
        run: { id: run.id, status: "success" },
        source: "conversation",
        total_messages: 2,
        next_offset: null,
      });
      expect(output.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      const [listFiles, postMessage, finalText] = output.messages[1].parts;
      expect(listFiles).toMatchObject({
        type: "tool_call",
        tool_name: "list_files",
        input: '{"folder":"reports"}',
        output: '{"files":["week-39.md"]}',
        is_error: false,
      });
      expect(postMessage).toMatchObject({
        type: "tool_call",
        tool_name: "slack__post_message",
        error: "channel_not_found",
        is_error: true,
      });
      expect(postMessage.input).toContain("[truncated");
      expect(finalText).toMatchObject({
        type: "text",
        text: "Posted the weekly report.",
      });
      expect(textOf(result)).toContain("untrusted data");
    });

    test("pages through the transcript with offset", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });
      const run = await makeRunWithConversation({
        triggerId: trigger.id,
        makeScheduleTriggerRun,
      });

      const first = await executeArchestraTool(
        GET_TRANSCRIPT,
        { schedule_trigger_id: trigger.id, run_id: run.id, limit: 1 },
        context,
      );
      const firstPage = first.structuredContent as TranscriptOutput;
      expect(firstPage.messages.map((m) => m.role)).toEqual(["user"]);
      expect(firstPage.next_offset).toBe(1);

      const second = await executeArchestraTool(
        GET_TRANSCRIPT,
        {
          schedule_trigger_id: trigger.id,
          run_id: run.id,
          offset: firstPage.next_offset,
        },
        context,
      );
      const secondPage = second.structuredContent as TranscriptOutput;
      expect(secondPage.messages.map((m) => m.role)).toEqual(["assistant"]);
      expect(secondPage.next_offset).toBeNull();
    });

    test("rebuilds an unopened run's transcript from its recorded LLM requests", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });
      const run = await makeScheduleTriggerRun(trigger.id);
      await InteractionModel.create({
        profileId: agent.id,
        userId,
        sessionId: `scheduled-${run.id}`,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Post the weekly report." }],
        },
        response: {
          id: "resp-1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Nothing to report this week.",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });
      await drainBackgroundWork();
      await ScheduleTriggerRunModel.markCompleted({
        runId: run.id,
        status: "success",
      });

      const result = await executeArchestraTool(
        GET_TRANSCRIPT,
        { schedule_trigger_id: trigger.id, run_id: run.id },
        context,
      );

      expect(result.isError, textOf(result)).toBe(false);
      const output = result.structuredContent as TranscriptOutput;
      expect(output.source).toBe("interaction_log");
      expect(
        output.messages.flatMap((m) => m.parts.map((p) => p.text)),
      ).toContain("Nothing to report this week.");
      // Reading is side-effect free: no conversation is minted for the run.
      expect(
        (await ScheduleTriggerRunModel.findById(run.id))?.chatConversationId,
      ).toBeNull();
    });

    test("points an Agent Runtime run at get_run", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });
      const run = await makeScheduleTriggerRun(trigger.id);
      const runtimeTaskId = crypto.randomUUID();
      expect(
        await ScheduleTriggerRunModel.setRuntimeTaskId({
          runId: run.id,
          taskId: runtimeTaskId,
        }),
      ).toBe(true);

      const result = await executeArchestraTool(
        GET_TRANSCRIPT,
        { schedule_trigger_id: trigger.id, run_id: run.id },
        context,
      );

      expect(result.isError, textOf(result)).toBe(false);
      const output = result.structuredContent as TranscriptOutput & {
        run: { runtime_task_id: string | null };
      };
      expect(output).toMatchObject({
        source: "agent_runtime",
        messages: [],
        run: { runtime_task_id: runtimeTaskId },
      });
      expect(output.note).toContain("get_run");
    });

    test("refuses a run id that belongs to a different schedule", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      const [a, b] = await Promise.all([
        makeScheduleTrigger({
          organizationId,
          agentId: agent.id,
          actorUserId: userId,
        }),
        makeScheduleTrigger({
          organizationId,
          agentId: agent.id,
          actorUserId: userId,
        }),
      ]);
      const run = await makeRunWithConversation({
        triggerId: b.id,
        makeScheduleTriggerRun,
      });

      const result = await executeArchestraTool(
        GET_TRANSCRIPT,
        { schedule_trigger_id: a.id, run_id: run.id },
        context,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Schedule trigger run not found");
    });

    test("denies a project member who can list the runs but is not the actor", async ({
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeUser,
      makeMember,
    }) => {
      const owner = await makeUser();
      await makeMember(owner.id, organizationId, { role: "member" });
      const project = await projectService.create({
        organizationId,
        userId,
        name: "shared-reports",
        description: null,
      });
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: owner.id,
        projectId: project.id,
      });
      const run = await makeScheduleTriggerRun(trigger.id);

      const listed = await executeArchestraTool(
        LIST_RUNS,
        { schedule_trigger_id: trigger.id },
        context,
      );
      expect(listed.isError).toBe(false);

      const result = await executeArchestraTool(
        GET_TRANSCRIPT,
        { schedule_trigger_id: trigger.id, run_id: run.id },
        context,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("do not have access");
    });
  });

  describe("mutations", () => {
    test("disable then enable flips the schedule", async ({
      makeScheduleTrigger,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
        enabled: true,
      });

      const disabled = await executeArchestraTool(
        DISABLE_TRIGGER,
        { schedule_trigger_id: trigger.id },
        context,
      );
      expect(disabled.isError).toBe(false);
      expect(disabled.structuredContent).toMatchObject({ enabled: false });

      await drainBackgroundWork();
      const enabled = await executeArchestraTool(
        ENABLE_TRIGGER,
        { schedule_trigger_id: trigger.id },
        context,
      );
      expect(enabled.isError).toBe(false);
      expect(enabled.structuredContent).toMatchObject({ enabled: true });
      await drainBackgroundWork();
      const { data } = await AuditLogModel.findPaginated({
        organizationId,
        resourceType: "scheduleTrigger",
        limit: 10,
        offset: 0,
      });
      expect(data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "scheduleTrigger.updated",
            before: expect.objectContaining({ enabled: true }),
            after: expect.objectContaining({ enabled: false }),
          }),
          expect.objectContaining({
            action: "scheduleTrigger.updated",
            before: expect.objectContaining({ enabled: false }),
            after: expect.objectContaining({ enabled: true }),
          }),
        ]),
      );
    });

    test("a project member cannot disable a schedule they do not act as", async ({
      makeScheduleTrigger,
      makeUser,
      makeMember,
    }) => {
      const owner = await makeUser();
      await makeMember(owner.id, organizationId, { role: "member" });
      const project = await projectService.create({
        organizationId,
        userId,
        name: "read-only-for-me",
        description: null,
      });
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: owner.id,
        projectId: project.id,
        enabled: true,
      });

      const result = await executeArchestraTool(
        DISABLE_TRIGGER,
        { schedule_trigger_id: trigger.id },
        context,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("do not have access");
    });

    test("run_schedule_trigger_now records a manual run and queues its execution", async ({
      makeScheduleTrigger,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });

      const started = await executeArchestraTool(
        RUN_NOW,
        { schedule_trigger_id: trigger.id },
        context,
      );

      expect(started.isError).toBe(false);
      expect(started.structuredContent).toMatchObject({
        trigger_id: trigger.id,
        run_kind: "manual",
        status: "running",
      });

      const history = await executeArchestraTool(
        LIST_RUNS,
        { schedule_trigger_id: trigger.id },
        context,
      );
      expect(
        (
          history.structuredContent as {
            runs: { id: string; completed_at: string | null }[];
          }
        ).runs.map((r) => r.id),
      ).toEqual([(started.structuredContent as { id: string }).id]);

      // A run row nobody queued would sit at `running` forever, which is
      // exactly the failure this tool is meant to make visible.
      expect(
        await TaskModel.findActivePayloadValues(
          "schedule_trigger_run_execute",
          "triggerId",
        ),
      ).toContain(trigger.id);
      await drainBackgroundWork();
      const { data } = await AuditLogModel.findPaginated({
        organizationId,
        resourceType: "scheduleTrigger",
        limit: 10,
        offset: 0,
      });
      expect(data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "scheduleTrigger.triggered",
            resourceId: trigger.id,
            after: expect.objectContaining({
              runId: started.structuredContent?.id,
              status: "running",
            }),
          }),
        ]),
      );
    });
  });

  describe("RBAC", () => {
    test("a role without scheduledTask permissions cannot read schedules", async ({
      makeScheduleTrigger,
      makeCustomRole,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });
      const role = await makeCustomRole(organizationId, { permission: {} });
      await MemberModel.updateRole(userId, organizationId, role.role);

      for (const tool of [LIST_TRIGGERS, GET_TRIGGER, LIST_RUNS]) {
        const result = await executeArchestraTool(
          tool,
          tool === LIST_TRIGGERS ? {} : { schedule_trigger_id: trigger.id },
          context,
        );
        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/permission/i);
      }
    });

    test("a read-only scheduledTask role cannot start a run", async ({
      makeScheduleTrigger,
      makeCustomRole,
    }) => {
      const trigger = await makeScheduleTrigger({
        organizationId,
        agentId: agent.id,
        actorUserId: userId,
      });
      const role = await makeCustomRole(organizationId, {
        permission: { scheduledTask: ["read"] },
      });
      await MemberModel.updateRole(userId, organizationId, role.role);

      const denied = await executeArchestraTool(
        RUN_NOW,
        { schedule_trigger_id: trigger.id },
        context,
      );
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toMatch(/permission/i);

      const allowed = await executeArchestraTool(
        GET_TRIGGER,
        { schedule_trigger_id: trigger.id },
        context,
      );
      expect(allowed.isError).toBe(false);
    });
  });
});
