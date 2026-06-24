import { ProjectShareModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/projects/:id/instructions", () => {
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

  async function seedProject(name = "p") {
    return projectService.create({
      organizationId,
      userId: owner.id,
      name,
      description: null,
    });
  }

  test("returns empty content before anything is saved", async () => {
    const project = await seedProject();
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/instructions`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: "" });
  });

  test("a shared reader can view the instructions", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("shared");
    await projectService.setInstructions({
      id: project.id,
      organizationId,
      userId: owner.id,
      content: "# House rules",
    });
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const member = await makeUser({ email: "instr-reader@test.com" });
    await makeMember(member.id, organizationId, {});
    actingUser = member;

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/instructions`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: "# House rules" });
  });

  test("a user without project access gets 404", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("private");
    const outsider = await makeUser({ email: "instr-outsider@test.com" });
    await makeMember(outsider.id, organizationId, {});
    actingUser = outsider;

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/instructions`,
    });
    expect(res.statusCode).toBe(404);
  });
});
