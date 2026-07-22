import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0299_backfill_orphaned_schedule_projects.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  if (statements.length === 0) {
    throw new Error("Migration statement not found");
  }

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function insertTrigger(params: {
  organizationId: string;
  agentId: string;
  actorUserId: string;
  projectId?: string;
  name?: string;
}) {
  const [trigger] = await db
    .insert(schema.scheduleTriggersTable)
    .values({
      organizationId: params.organizationId,
      name: params.name ?? "Daily digest",
      agentId: params.agentId,
      projectId: params.projectId ?? null,
      messageTemplate: "run the daily digest",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      actorUserId: params.actorUserId,
    })
    .returning();
  return trigger;
}

async function getTriggerProjectId(triggerId: string): Promise<string | null> {
  const [trigger] = await db
    .select({ projectId: schema.scheduleTriggersTable.projectId })
    .from(schema.scheduleTriggersTable)
    .where(eq(schema.scheduleTriggersTable.id, triggerId));
  return trigger.projectId;
}

async function listProjects(organizationId: string) {
  return db
    .select()
    .from(schema.projectsTable)
    .where(eq(schema.projectsTable.organizationId, organizationId));
}

describe("0299 migration: backfill orphaned schedule projects", () => {
  test("creates one project per owner and links all their orphaned triggers", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const triggerA = await insertTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: user.id,
      name: "Morning report",
    });
    const triggerB = await insertTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: user.id,
      name: "Evening report",
    });

    await runMigration();

    const projects = await listProjects(org.id);
    expect(projects).toHaveLength(1);
    const [project] = projects;
    expect(project.userId).toBe(user.id);
    expect(project.name).toBe("Migrated Schedules");
    expect(project.slug.startsWith("migrated-schedules-")).toBe(true);
    expect(project.description).toContain(
      "Agent Schedules moved into Projects",
    );

    expect(await getTriggerProjectId(triggerA.id)).toBe(project.id);
    expect(await getTriggerProjectId(triggerB.id)).toBe(project.id);
  });

  test("groups orphaned triggers by owner within an org", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const userOne = await makeUser({ email: "owner-one@test.com" });
    const userTwo = await makeUser({ email: "owner-two@test.com" });
    const agent = await makeAgent({ organizationId: org.id });

    const triggerOne = await insertTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: userOne.id,
    });
    const triggerTwo = await insertTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: userTwo.id,
    });

    await runMigration();

    const projects = await listProjects(org.id);
    expect(projects).toHaveLength(2);
    // each owner gets a distinct project, and slugs stay unique within the org.
    expect(new Set(projects.map((p) => p.slug)).size).toBe(2);

    const projectOne = projects.find((p) => p.userId === userOne.id);
    const projectTwo = projects.find((p) => p.userId === userTwo.id);
    expect(projectOne).toBeDefined();
    expect(projectTwo).toBeDefined();
    expect(await getTriggerProjectId(triggerOne.id)).toBe(projectOne?.id);
    expect(await getTriggerProjectId(triggerTwo.id)).toBe(projectTwo?.id);
  });

  test("leaves triggers that already belong to a project untouched", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const [existingProject] = await db
      .insert(schema.projectsTable)
      .values({
        organizationId: org.id,
        userId: user.id,
        name: "Existing Project",
        slug: "existing-project",
      })
      .returning();

    const assignedTrigger = await insertTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: user.id,
      projectId: existingProject.id,
    });

    await runMigration();

    // no auto-generated project was created, and the assignment is unchanged.
    const projects = await listProjects(org.id);
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(existingProject.id);
    expect(await getTriggerProjectId(assignedTrigger.id)).toBe(
      existingProject.id,
    );
  });

  test("suffixes the project name when an owner has orphans in multiple orgs", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const orgA = await makeOrganization({ name: "Org A", slug: "org-a-sched" });
    const orgB = await makeOrganization({ name: "Org B", slug: "org-b-sched" });
    const user = await makeUser();
    const agentA = await makeAgent({ organizationId: orgA.id });
    const agentB = await makeAgent({ organizationId: orgB.id });

    await insertTrigger({
      organizationId: orgA.id,
      agentId: agentA.id,
      actorUserId: user.id,
    });
    await insertTrigger({
      organizationId: orgB.id,
      agentId: agentB.id,
      actorUserId: user.id,
    });

    await runMigration();

    const ownerProjects = await db
      .select()
      .from(schema.projectsTable)
      .where(eq(schema.projectsTable.userId, user.id));

    expect(ownerProjects).toHaveLength(2);
    // (user_id, name) is unique, so the second org's project gets a suffix.
    expect(new Set(ownerProjects.map((p) => p.name))).toEqual(
      new Set(["Migrated Schedules", "Migrated Schedules 2"]),
    );

    // every orphaned trigger ended up linked to a project.
    const remainingOrphans = await db
      .select({ id: schema.scheduleTriggersTable.id })
      .from(schema.scheduleTriggersTable)
      .where(
        and(
          eq(schema.scheduleTriggersTable.actorUserId, user.id),
          isNull(schema.scheduleTriggersTable.projectId),
        ),
      );
    expect(remainingOrphans).toHaveLength(0);
  });
});
