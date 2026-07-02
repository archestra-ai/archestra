import { PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  ProjectMemoryLimitError,
  ProjectMemoryModel,
  ProjectMemoryProjectGoneError,
  ProjectModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import type { User } from "@/types";

async function seed(makeOrganization: () => Promise<{ id: string }>, user: User) {
  const organizationId = (await makeOrganization()).id;
  const project = await ProjectModel.create({
    organizationId,
    userId: user.id,
    name: "memory-project",
    description: null,
    icon: null,
  });
  return { organizationId, project };
}

describe("ProjectMemoryModel", () => {
  test("create / list / update / delete round-trip", async ({
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const { organizationId, project } = await seed(makeOrganization, user);

    const created = await ProjectMemoryModel.create({
      projectId: project.id,
      organizationId,
      createdByUserId: user.id,
      content: "the launch is July 15",
    });
    expect(created.content).toBe("the launch is July 15");

    let listed = await ProjectMemoryModel.listByProject({
      projectId: project.id,
      organizationId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.id,
      content: "the launch is July 15",
      authorName: user.name,
    });

    const updated = await ProjectMemoryModel.update({
      id: created.id,
      projectId: project.id,
      organizationId,
      content: "the launch moved to July 22",
    });
    expect(updated?.content).toBe("the launch moved to July 22");

    expect(
      await ProjectMemoryModel.delete({
        id: created.id,
        projectId: project.id,
        organizationId,
      }),
    ).toBe(true);
    listed = await ProjectMemoryModel.listByProject({
      projectId: project.id,
      organizationId,
    });
    expect(listed).toHaveLength(0);
  });

  test("lists newest first", async ({ makeOrganization, makeUser }) => {
    const user = await makeUser();
    const { organizationId, project } = await seed(makeOrganization, user);

    const first = await ProjectMemoryModel.create({
      projectId: project.id,
      organizationId,
      createdByUserId: user.id,
      content: "first",
    });
    // Stamp distinct creation times: PGlite can give both inserts the same
    // now(), making newest-first ordering ambiguous.
    await db
      .update(schema.projectMemoriesTable)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.projectMemoriesTable.id, first.id));
    await ProjectMemoryModel.create({
      projectId: project.id,
      organizationId,
      createdByUserId: user.id,
      content: "second",
    });

    const listed = await ProjectMemoryModel.listByProject({
      projectId: project.id,
      organizationId,
    });
    expect(listed.map((memory) => memory.content)).toEqual([
      "second",
      "first",
    ]);
  });

  test("update/delete with a foreign project or org resolve to not-found", async ({
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const { organizationId, project } = await seed(makeOrganization, user);
    const other = await ProjectModel.create({
      organizationId,
      userId: user.id,
      name: "other-project",
      description: null,
      icon: null,
    });

    const memory = await ProjectMemoryModel.create({
      projectId: project.id,
      organizationId,
      createdByUserId: user.id,
      content: "scoped",
    });

    // wrong project
    expect(
      await ProjectMemoryModel.update({
        id: memory.id,
        projectId: other.id,
        organizationId,
        content: "nope",
      }),
    ).toBeNull();
    // wrong org
    expect(
      await ProjectMemoryModel.delete({
        id: memory.id,
        projectId: project.id,
        organizationId: "some-other-org",
      }),
    ).toBe(false);

    const listed = await ProjectMemoryModel.listByProject({
      projectId: project.id,
      organizationId,
    });
    expect(listed[0].content).toBe("scoped");
  });

  test("enforces the per-project entry cap", async ({
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const { organizationId, project } = await seed(makeOrganization, user);

    // Fill straight through the model-free bulk path — creating 100 entries
    // one lock-transaction at a time is needless test latency.
    await db.insert(schema.projectMemoriesTable).values(
      Array.from({ length: PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT }, (_, i) => ({
        projectId: project.id,
        organizationId,
        createdByUserId: user.id,
        content: `memory ${i}`,
      })),
    );

    await expect(
      ProjectMemoryModel.create({
        projectId: project.id,
        organizationId,
        createdByUserId: user.id,
        content: "one too many",
      }),
    ).rejects.toBeInstanceOf(ProjectMemoryLimitError);
  });

  test("creating against a deleted project throws project-gone", async ({
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const { organizationId, project } = await seed(makeOrganization, user);
    await ProjectModel.delete(project.id);

    await expect(
      ProjectMemoryModel.create({
        projectId: project.id,
        organizationId,
        createdByUserId: user.id,
        content: "orphan",
      }),
    ).rejects.toBeInstanceOf(ProjectMemoryProjectGoneError);
  });

  test("memories are deleted with their project (FK cascade)", async ({
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const { organizationId, project } = await seed(makeOrganization, user);
    await ProjectMemoryModel.create({
      projectId: project.id,
      organizationId,
      createdByUserId: user.id,
      content: "doomed",
    });

    await ProjectModel.delete(project.id);

    const rows = await db
      .select()
      .from(schema.projectMemoriesTable)
      .where(eq(schema.projectMemoriesTable.projectId, project.id));
    expect(rows).toHaveLength(0);
  });

  test("author attribution survives as null after user deletion", async ({
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const { organizationId, project } = await seed(makeOrganization, user);
    const author = await makeUser({ email: "author-gone@test.com" });
    await ProjectMemoryModel.create({
      projectId: project.id,
      organizationId,
      createdByUserId: author.id,
      content: "kept",
    });

    await db
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, author.id));

    const listed = await ProjectMemoryModel.listByProject({
      projectId: project.id,
      organizationId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ content: "kept", authorName: null });
  });
});
