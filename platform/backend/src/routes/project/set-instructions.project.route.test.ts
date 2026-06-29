import {
  PROJECT_INSTRUCTIONS_FILENAME,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
} from "@archestra/shared";
import { ProjectShareModel } from "@/models";
import FileModel from "@/models/file";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("PUT /api/projects/:id/instructions", () => {
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

  function instructionsRow(projectId: string) {
    return FileModel.findByProjectAndName({
      organizationId,
      projectId,
      filename: PROJECT_INSTRUCTIONS_FILENAME,
    });
  }

  const get = (projectId: string) =>
    app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/instructions`,
    });

  const put = (projectId: string, content: string) =>
    app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/instructions`,
      payload: { content },
    });

  test("first empty save creates the file; content round-trips; empty is kept", async () => {
    const project = await seedProject();

    // Created on the first save, even when empty — but reads back as "".
    const empty = await put(project.id, "");
    expect(empty.statusCode).toBe(200);
    expect((await get(project.id)).json()).toEqual({ content: "" });
    expect(await instructionsRow(project.id)).not.toBeNull();

    // Content round-trips.
    expect((await put(project.id, "# Rules")).statusCode).toBe(200);
    expect((await get(project.id)).json()).toEqual({ content: "# Rules" });

    // Emptying keeps the (now empty) real file — it is not deleted.
    expect((await put(project.id, "")).statusCode).toBe(200);
    expect((await get(project.id)).json()).toEqual({ content: "" });
    expect(await instructionsRow(project.id)).not.toBeNull();
  });

  test("content over the max length is rejected with 400", async () => {
    const project = await seedProject("limit");

    expect(
      (await put(project.id, "x".repeat(PROJECT_INSTRUCTIONS_MAX_LENGTH)))
        .statusCode,
    ).toBe(200);
    expect(
      (await put(project.id, "x".repeat(PROJECT_INSTRUCTIONS_MAX_LENGTH + 1)))
        .statusCode,
    ).toBe(400);
  });

  test("a non-owner with read access cannot edit (404, file unchanged)", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("guarded");
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const member = await makeUser({ email: "instr-writer@test.com" });
    await makeMember(member.id, organizationId, {});
    actingUser = member;

    const res = await put(project.id, "i should not be able to set this");
    expect(res.statusCode).toBe(404);
    expect(await instructionsRow(project.id)).toBeNull();
  });
});
