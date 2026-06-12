import { SkillModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/skills/:id", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: skillRoutes } = await import("./skill.routes");
    await app.register(skillRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("a personal skill is hidden from non-authors", async ({ makeUser }) => {
    const author = await makeUser();
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        authorId: author.id,
        name: "someone-elses-skill",
        description: "private",
        content: "# private",
        metadata: {},
        sourceType: "manual",
        scope: "personal",
      },
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    // current request user is not the author and not an admin
    const getResponse = await app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}`,
    });
    expect(getResponse.statusCode).toBe(404);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/skills",
    });
    expect(
      listResponse.json().data.map((s: { id: string }) => s.id),
    ).not.toContain(skill.id);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/skills/${skill.id}`,
    });
    expect(deleteResponse.statusCode).toBe(404);
  });
});
