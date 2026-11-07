import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { SkillFileModel, SkillModel, SkillVersionModel } from "@/models";
import { syncBuiltInSkills } from "@/services/seed";
import {
  builtInSkillSourceRef,
  getEnabledBuiltInSkills,
} from "@/skills/built-in-skills";
import {
  accessGrants,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import type { User } from "@/types";
import skillRoutes from "./skill.routes";
import { useSkillRouteTestApp } from "./skill.test-helpers";

const [BASE_SKILL] = getEnabledBuiltInSkills();

describe("POST /api/skills/:id/reset", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organizationId;
    });

    const { default: skillRoutes } = await import("./skill.routes");
    await app.register(skillRoutes);

    await syncBuiltInSkills();
  });

  afterEach(async () => {
    await app.close();
  });

  async function getBaseSkillId(): Promise<string> {
    const skill = await SkillModel.findBuiltIn({
      organizationId,
      sourceRef: builtInSkillSourceRef(BASE_SKILL.builtInSkillId),
    });
    if (!skill) throw new Error("built-in skill not seeded");
    return skill.id;
  }

  test("restores an edited built-in skill to its shipped default", async () => {
    const id = await getBaseSkillId();

    // user edits the skill, wiping its files.
    await SkillModel.updateWithFiles({
      id,
      skill: { content: "tampered" },
      files: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/skills/${id}/reset`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ content: BASE_SKILL.content });

    const files = await SkillFileModel.findBySkillId(id);
    expect(files).toHaveLength(BASE_SKILL.files.length);
  });

  test("leaves built-in versions without a source commit", async () => {
    const id = await getBaseSkillId();
    await SkillModel.updateWithFiles({
      id,
      skill: { content: "tampered" },
      files: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/skills/${id}/reset`,
    });
    expect(response.statusCode).toBe(200);

    // `skills.source_commit` holds a content hash for built-ins, not a git SHA.
    // Inheriting it would link the history out to a commit that does not exist.
    const skill = await SkillModel.findById(id);
    const versions = await Promise.all(
      Array.from({ length: skill?.latestVersion ?? 0 }, (_, i) =>
        SkillVersionModel.findBySkillAndVersion(id, i + 1),
      ),
    );
    expect(versions).not.toHaveLength(0);
    expect(versions.map((version) => version?.sourceCommit)).toEqual(
      versions.map(() => null),
    );
  });

  test("flags an edited copy that missed a newer default until it is reset", async () => {
    const id = await getBaseSkillId();
    // An edited copy last written by an older release: sync preserves the
    // edit, so the copy keeps that release's revision.
    await SkillModel.updateWithFiles({
      id,
      skill: { content: "tampered", sourceCommit: "older-release" },
    });
    await syncBuiltInSkills();

    const detail = await app.inject({
      method: "GET",
      url: `/api/skills/${id}`,
    });
    expect(detail.json()).toMatchObject({ builtInUpdateAvailable: true });
    const list = await app.inject({
      method: "GET",
      url: "/api/skills?limit=100&offset=0",
    });
    const listed = list
      .json()
      .data.find((skill: { id: string }) => skill.id === id);
    expect(listed).toMatchObject({ builtInUpdateAvailable: true });

    const reset = await app.inject({
      method: "POST",
      url: `/api/skills/${id}/reset`,
    });
    expect(reset.json()).toMatchObject({ builtInUpdateAvailable: false });
  });

  test("does not flag an edited copy when nothing newer ships", async () => {
    const id = await getBaseSkillId();
    await SkillModel.updateWithFiles({ id, skill: { content: "tampered" } });

    const detail = await app.inject({
      method: "GET",
      url: `/api/skills/${id}`,
    });
    expect(detail.json()).toMatchObject({ builtInUpdateAvailable: false });
  });

  test("rejects resetting a non-built-in skill", async () => {
    const manual = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "Manual skill",
        description: "desc",
        content: "# manual",
        sourceType: "manual",
      },
      files: [],
      ...accessGrants("org"),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/skills/${manual?.id}/reset`,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/skills/:id/reset — scope visibility", () => {
  const ctx = useSkillRouteTestApp(skillRoutes);

  test("a skill the caller cannot see returns 404, not a 400 that leaks its type", async ({
    makeUser,
  }) => {
    const author = await makeUser();
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: ctx.organizationId,
        authorId: author.id,
        name: "someone-elses-skill",
        description: "private",
        content: "# private",
        metadata: {},
        sourceType: "manual",
      },
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    // request user is neither the author nor an admin, so the skill is not
    // visible to them: reset must 404 before the sourceType 400 fires.
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/reset`,
    });

    expect(response.statusCode).toBe(404);
  });
});
