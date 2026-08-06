import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import {
  AgentModel,
  AppModel,
  FileModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ProjectModel,
  SkillModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
  TaskModel,
  ToolModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type { Skill } from "@/types";

const FORTY_DAYS_AGO = () => new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
const THIRTY_FIVE_DAYS_AGO = () =>
  new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);

async function seedSkill(organizationId: string, name: string): Promise<Skill> {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId,
      authorId: null,
      name,
      description: `${name} description`,
      content: `# ${name}`,
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [{ path: "helper.py", content: "print('hi')", kind: "script" }],
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

describe("SkillModel.purge", () => {
  test("deletes the skill and its version rows", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await seedSkill(org.id, "purgeable");
    await SkillModel.delete(skill.id);

    expect(
      await SkillModel.purge({ id: skill.id, organizationId: org.id }),
    ).toBe(true);

    const versions = await db
      .select()
      .from(schema.skillVersionsTable)
      .where(eq(schema.skillVersionsTable.skillId, skill.id));
    expect(versions).toEqual([]);
    const [raw] = await db
      .select()
      .from(schema.skillsTable)
      .where(eq(schema.skillsTable.id, skill.id));
    expect(raw).toBeUndefined();
  });

  test("refuses while a sandbox mount pins one of its versions", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "mounted");
    const version = await SkillVersionModel.findBySkillAndVersion(
      skill.id,
      skill.latestVersion,
    );
    if (!version) throw new Error("skill has no version");

    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      mount: {
        skillId: skill.id,
        skillName: skill.name,
        skillVersionId: version.id,
      },
    });
    await SkillModel.delete(skill.id);

    expect(await SkillVersionModel.hasSandboxMountsForSkill(skill.id)).toBe(
      true,
    );
    // The RESTRICT foreign key is the guard, and it aborts the transaction —
    // callers pre-check (see the route's 409 and the sweep's skip) and map this
    // to their own answer.
    await expect(
      SkillModel.purge({ id: skill.id, organizationId: org.id }),
    ).rejects.toThrow();

    // Skill and version rows survive the refused purge intact.
    expect(await SkillModel.findDeletedById(skill.id, org.id)).not.toBeNull();
    expect(
      await SkillVersionModel.findBySkillAndVersion(
        skill.id,
        skill.latestVersion,
      ),
    ).not.toBeNull();

    // Once the pinning sandbox is gone (cascading its mounts), the purge runs.
    await db
      .delete(schema.skillSandboxesTable)
      .where(eq(schema.skillSandboxesTable.id, sandbox.id));
    expect(await SkillVersionModel.hasSandboxMountsForSkill(skill.id)).toBe(
      false,
    );
    expect(
      await SkillModel.purge({ id: skill.id, organizationId: org.id }),
    ).toBe(true);
  });

  test("drops the skill's queued GitHub-sync tasks", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await seedSkill(org.id, "synced");
    await TaskModel.create({
      taskType: "skill_github_sync",
      payload: { skillId: skill.id },
    });
    await SkillModel.delete(skill.id);

    expect(
      await SkillModel.purge({ id: skill.id, organizationId: org.id }),
    ).toBe(true);

    const tasks = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "skill_github_sync"));
    expect(tasks).toEqual([]);
  });

  test("onlyIfDeletedForDays refuses active and not-yet-aged rows", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await seedSkill(org.id, "guarded");

    // Active row: even a 0-day guard refuses (it is not soft-deleted).
    expect(
      await SkillModel.purge(
        { id: skill.id, organizationId: org.id },
        { onlyIfDeletedForDays: 0 },
      ),
    ).toBe(false);

    // Freshly deleted: inside a 30-day window.
    await SkillModel.delete(skill.id);
    expect(
      await SkillModel.purge(
        { id: skill.id, organizationId: org.id },
        { onlyIfDeletedForDays: 30 },
      ),
    ).toBe(false);
    expect(await SkillModel.findDeletedById(skill.id, org.id)).not.toBeNull();

    // Aged out: purged.
    await db
      .update(schema.skillsTable)
      .set({ deletedAt: FORTY_DAYS_AGO() })
      .where(eq(schema.skillsTable.id, skill.id));
    expect(
      await SkillModel.purge(
        { id: skill.id, organizationId: org.id },
        { onlyIfDeletedForDays: 30 },
      ),
    ).toBe(true);
  });
});

describe("McpServerModel.hardDelete", () => {
  test("destroys the retained secret bag", async ({ makeMcpServer }) => {
    const secret = await secretManager().createSecret(
      { API_KEY: "retained-for-restore" },
      "purge-test-secret",
    );
    const server = await makeMcpServer();
    await db
      .update(schema.mcpServersTable)
      .set({ secretId: secret.id, deletedAt: FORTY_DAYS_AGO() })
      .where(eq(schema.mcpServersTable.id, server.id));

    expect(
      await McpServerModel.hardDelete(server.id, { onlyIfDeletedForDays: 30 }),
    ).toBe(true);

    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, server.id));
    expect(serverRow).toBeUndefined();
    const [secretRow] = await db
      .select()
      .from(schema.secretsTable)
      .where(eq(schema.secretsTable.id, secret.id));
    expect(secretRow).toBeUndefined();
  });
});

describe("InternalMcpCatalogModel.hardDelete", () => {
  test("refuses while an install still references the catalog", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    const server = await makeMcpServer({ catalogId: catalog.id });
    const at = FORTY_DAYS_AGO();
    await db
      .update(schema.internalMcpCatalogTable)
      .set({ deletedAt: at })
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    await db
      .update(schema.mcpServersTable)
      .set({ deletedAt: at })
      .where(eq(schema.mcpServersTable.id, server.id));

    // The soft-deleted install pins the catalog: skipped, retried next sweep.
    expect(
      await InternalMcpCatalogModel.hardDelete(catalog.id, {
        onlyIfDeletedForDays: 30,
      }),
    ).toBe(false);

    // Once the install is purged, the catalog goes too.
    expect(
      await McpServerModel.hardDelete(server.id, { onlyIfDeletedForDays: 30 }),
    ).toBe(true);
    expect(
      await InternalMcpCatalogModel.hardDelete(catalog.id, {
        onlyIfDeletedForDays: 30,
      }),
    ).toBe(true);
  });
});

describe("file-store byte purge (filesystem provider)", () => {
  let root: string;
  let savedProvider: typeof config.fileStorage.provider;
  let savedRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "purge-bytes-"));
    savedProvider = config.fileStorage.provider;
    savedRoot = config.fileStorage.filesystemRoot;
    config.fileStorage.provider = "filesystem";
    config.fileStorage.filesystemRoot = root;
  });
  afterEach(async () => {
    config.fileStorage.provider = savedProvider;
    config.fileStorage.filesystemRoot = savedRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedStoredFile(params: {
    organizationId: string;
    userId: string;
    projectId?: string | null;
    appId?: string | null;
    filename: string;
    folder: string;
  }) {
    const dir = path.join(root, params.folder);
    await fs.mkdir(dir, { recursive: true });
    const onDisk = path.join(dir, params.filename);
    await fs.writeFile(onDisk, "bytes");
    const row = await FileModel.insertRow({
      organizationId: params.organizationId,
      userId: params.userId,
      projectId: params.projectId ?? null,
      conversationId: null,
      appId: params.appId ?? null,
      filename: params.filename,
      mimeType: "text/plain",
      sizeBytes: 5,
      storageProvider: "filesystem",
      data: null,
      objectKey: `${params.folder}/${params.filename}`,
    });
    return { row, onDisk };
  }

  test("purges file rows, bytes, and queued trigger tasks", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "purge-me",
    });
    const { row, onDisk } = await seedStoredFile({
      organizationId: org.id,
      userId: user.id,
      projectId: project.id,
      filename: "result.txt",
      folder: project.slug,
    });
    const [trigger] = await db
      .insert(schema.scheduleTriggersTable)
      .values({
        organizationId: org.id,
        name: "nightly",
        agentId: agent.id,
        projectId: project.id,
        actorUserId: user.id,
        messageTemplate: "run",
        cronExpression: "0 0 * * *",
        timezone: "UTC",
      })
      .returning();
    await TaskModel.create({
      taskType: "schedule_trigger_run_execute",
      payload: { runId: crypto.randomUUID(), triggerId: trigger.id },
    });

    await ProjectModel.delete(project.id);
    await db
      .update(schema.projectsTable)
      .set({ deletedAt: FORTY_DAYS_AGO() })
      .where(eq(schema.projectsTable.id, project.id));

    expect(
      await projectService.purgeUnchecked(
        { id: project.id, organizationId: org.id },
        { onlyIfDeletedForDays: 30 },
      ),
    ).toBe(true);

    expect(await FileModel.findById(row.id)).toBeNull();
    await expect(fs.access(onDisk)).rejects.toThrow();
    const tasks = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "schedule_trigger_run_execute"));
    expect(tasks).toEqual([]);
    const [projectRow] = await db
      .select()
      .from(schema.projectsTable)
      .where(eq(schema.projectsTable.id, project.id));
    expect(projectRow).toBeUndefined();
  });

  test("AppModel.hardDelete purges version rows, file rows, and bytes", async ({
    makeApp,
    makeUser,
  }) => {
    const app = await makeApp({ html: "<h1>hi</h1>" });
    const user = await makeUser();
    const { row, onDisk } = await seedStoredFile({
      organizationId: app.organizationId,
      userId: user.id,
      appId: app.id,
      filename: "artifact.txt",
      folder: "app-files",
    });

    await AppModel.delete(app.id);
    await db
      .update(schema.appsTable)
      .set({ deletedAt: FORTY_DAYS_AGO() })
      .where(eq(schema.appsTable.id, app.id));

    expect(
      await AppModel.hardDelete(app.id, { onlyIfDeletedForDays: 30 }),
    ).toBe(true);

    expect(await FileModel.findById(row.id)).toBeNull();
    await expect(fs.access(onDisk)).rejects.toThrow();
    const versions = await db
      .select()
      .from(schema.appVersionsTable)
      .where(eq(schema.appVersionsTable.appId, app.id));
    expect(versions).toEqual([]);
    const [appRow] = await db
      .select()
      .from(schema.appsTable)
      .where(eq(schema.appsTable.id, app.id));
    expect(appRow).toBeUndefined();
  });
});

describe("AgentModel.purge", () => {
  test("unlinks interactions, clears org defaults, then deletes the row", async ({
    makeOrganization,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const interaction = await makeInteraction(agent.id);
    await db
      .update(schema.organizationsTable)
      .set({ defaultAgentId: agent.id })
      .where(eq(schema.organizationsTable.id, org.id));
    await db
      .update(schema.agentsTable)
      .set({ deletedAt: FORTY_DAYS_AGO() })
      .where(eq(schema.agentsTable.id, agent.id));

    expect(
      await AgentModel.purge(agent.id, org.id, { onlyIfDeletedForDays: 30 }),
    ).toBe(true);

    const [interactionRow] = await db
      .select({ profileId: schema.interactionsTable.profileId })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, interaction.id));
    expect(interactionRow?.profileId).toBeNull();
    const [orgRow] = await db
      .select({ defaultAgentId: schema.organizationsTable.defaultAgentId })
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, org.id));
    expect(orgRow?.defaultAgentId).toBeNull();
    const [agentRow] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agent.id));
    expect(agentRow).toBeUndefined();
  });

  test("a not-yet-aged soft-deleted agent survives the guarded purge", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    await AgentModel.delete(agent.id);

    expect(
      await AgentModel.purge(agent.id, org.id, { onlyIfDeletedForDays: 30 }),
    ).toBe(false);

    const [agentRow] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agent.id));
    expect(agentRow?.deletedAt).toBeInstanceOf(Date);
  });

  test("purges queued trigger runs with the row", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await seedQueuedTriggerRun({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: user.id,
    });
    await db
      .update(schema.agentsTable)
      .set({ deletedAt: FORTY_DAYS_AGO() })
      .where(eq(schema.agentsTable.id, agent.id));

    expect(
      await AgentModel.purge(agent.id, org.id, { onlyIfDeletedForDays: 30 }),
    ).toBe(true);

    const tasks = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "schedule_trigger_run_execute"));
    expect(tasks).toEqual([]);
  });

  test("a restore that wins the purge race keeps the queued trigger runs", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await seedQueuedTriggerRun({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: user.id,
    });
    await db
      .update(schema.agentsTable)
      .set({ deletedAt: FORTY_DAYS_AGO() })
      .where(eq(schema.agentsTable.id, agent.id));

    // The restore commits first, so the purge's FOR UPDATE re-check finds no
    // soft-deleted row and takes nothing. Everything destructive runs after
    // that check, inside the same transaction, so a lost race costs nothing.
    await db
      .update(schema.agentsTable)
      .set({ deletedAt: null })
      .where(eq(schema.agentsTable.id, agent.id));

    expect(
      await AgentModel.purge(agent.id, org.id, { onlyIfDeletedForDays: 30 }),
    ).toBe(false);

    // The restored agent survives with its queued scheduled run intact.
    const [agentRow] = await db
      .select({ deletedAt: schema.agentsTable.deletedAt })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agent.id));
    expect(agentRow?.deletedAt).toBeNull();
    const tasks = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "schedule_trigger_run_execute"));
    expect(tasks).toHaveLength(1);
  });
});

// The purge sweep pages its scans with OFFSET = its skipped-row count; the
// two org-inferring raw-SQL scans are not covered by the shared-helper tests.
describe("findExpiredDeleted offset paging (bespoke scans)", () => {
  test("ToolModel.findExpiredDeleted skips the scan's oldest rows", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const older = await makeTool({ catalogId: catalog.id });
    const younger = await makeTool({ catalogId: catalog.id });
    await db
      .update(schema.toolsTable)
      .set({ deletedAt: FORTY_DAYS_AGO() })
      .where(eq(schema.toolsTable.id, older.id));
    await db
      .update(schema.toolsTable)
      .set({ deletedAt: THIRTY_FIVE_DAYS_AGO() })
      .where(eq(schema.toolsTable.id, younger.id));

    const all = await ToolModel.findExpiredDeleted({
      retentionDays: 30,
      limit: 10,
      offset: 0,
    });
    expect(all.map((r) => r.id)).toEqual([older.id, younger.id]);

    const page = await ToolModel.findExpiredDeleted({
      retentionDays: 30,
      limit: 10,
      offset: 1,
    });
    expect(page).toEqual([{ id: younger.id, organizationId: org.id }]);
  });

  test("McpServerModel.findExpiredDeleted skips the scan's oldest rows", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const older = await makeMcpServer({ teamId: team.id });
    const younger = await makeMcpServer({ teamId: team.id });
    await db
      .update(schema.mcpServersTable)
      .set({ deletedAt: FORTY_DAYS_AGO() })
      .where(eq(schema.mcpServersTable.id, older.id));
    await db
      .update(schema.mcpServersTable)
      .set({ deletedAt: THIRTY_FIVE_DAYS_AGO() })
      .where(eq(schema.mcpServersTable.id, younger.id));

    const all = await McpServerModel.findExpiredDeleted({
      retentionDays: 30,
      limit: 10,
      offset: 0,
    });
    expect(all.map((r) => r.id)).toEqual([older.id, younger.id]);

    const page = await McpServerModel.findExpiredDeleted({
      retentionDays: 30,
      limit: 10,
      offset: 1,
    });
    expect(page).toEqual([{ id: younger.id, organizationId: org.id }]);
  });
});

/** A schedule trigger for the agent plus one queued run-execute task. */
async function seedQueuedTriggerRun(params: {
  organizationId: string;
  agentId: string;
  actorUserId: string;
}): Promise<void> {
  const [trigger] = await db
    .insert(schema.scheduleTriggersTable)
    .values({
      organizationId: params.organizationId,
      name: "nightly",
      agentId: params.agentId,
      actorUserId: params.actorUserId,
      messageTemplate: "run",
      cronExpression: "0 0 * * *",
      timezone: "UTC",
    })
    .returning();
  await TaskModel.create({
    taskType: "schedule_trigger_run_execute",
    payload: { runId: crypto.randomUUID(), triggerId: trigger.id },
  });
}
