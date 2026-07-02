import { PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT } from "@archestra/shared";
import db, { schema } from "@/database";
import { ProjectShareModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("/api/projects/:id/memories", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let owner: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    owner = await makeUser();
    actingUser = owner;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = actingUser;
    });
    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedProject(name = "memories-p") {
    return projectService.create({
      organizationId,
      userId: owner.id,
      name,
      description: null,
    });
  }

  async function saveMemory(projectId: string, content: string) {
    return app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/memories`,
      payload: { content },
    });
  }

  test("save, list, update, delete round-trip", async () => {
    const project = await seedProject();

    const created = await saveMemory(project.id, "the launch is July 15");
    expect(created.statusCode).toBe(200);
    const memory = created.json();
    expect(memory).toMatchObject({
      content: "the launch is July 15",
      authorName: owner.name,
    });

    let listed = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/memories`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/memories/${memory.id}`,
      payload: { content: "the launch moved to July 22" },
    });
    expect(updated.statusCode).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/memories/${memory.id}`,
    });
    expect(deleted.statusCode).toBe(200);

    listed = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/memories`,
    });
    expect(listed.json()).toHaveLength(0);
  });

  test("a shared member can list and save; an outsider gets 404", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("shared-mem");
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });

    const member = await makeUser({ email: "mem-member@test.com" });
    await makeMember(member.id, organizationId, {});
    actingUser = member;

    const saved = await saveMemory(project.id, "from a shared member");
    expect(saved.statusCode).toBe(200);
    const listed = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/memories`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()[0].content).toBe("from a shared member");

    // A different project that is NOT shared is invisible to the member.
    actingUser = owner;
    const privateProject = await seedProject("private-mem");
    actingUser = member;
    const denied = await saveMemory(privateProject.id, "should not land");
    expect(denied.statusCode).toBe(404);
    const deniedList = await app.inject({
      method: "GET",
      url: `/api/projects/${privateProject.id}/memories`,
    });
    expect(deniedList.statusCode).toBe(404);
  });

  test("update/delete of a foreign memory id 404s", async () => {
    const project = await seedProject("foreign-id");
    const other = await seedProject("foreign-id-other");
    const created = await saveMemory(other.id, "belongs elsewhere");
    const memoryId = created.json().id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/memories/${memoryId}`,
      payload: { content: "hijack" },
    });
    expect(updated.statusCode).toBe(404);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/memories/${memoryId}`,
    });
    expect(deleted.statusCode).toBe(404);
  });

  test("empty and whitespace-only content is rejected", async () => {
    const project = await seedProject("validation");
    const empty = await saveMemory(project.id, "");
    expect(empty.statusCode).toBe(400);
    const blank = await saveMemory(project.id, "   ");
    expect(blank.statusCode).toBe(400);
  });

  test("the per-project cap returns 409 with a consolidation hint", async () => {
    const project = await seedProject("full");
    await db.insert(schema.projectMemoriesTable).values(
      Array.from({ length: PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT }, (_, i) => ({
        projectId: project.id,
        organizationId,
        createdByUserId: owner.id,
        content: `memory ${i}`,
      })),
    );

    const res = await saveMemory(project.id, "one too many");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("consolidate");
  });
});
