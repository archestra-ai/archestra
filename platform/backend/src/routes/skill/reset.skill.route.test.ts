import { syncBuiltInSkills } from "@/database/seed";
import { SkillFileModel, SkillModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  BUILT_IN_SKILLS,
  builtInSkillSourceRef,
} from "@/skills/built-in-skills";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const [BASE_SKILL] = BUILT_IN_SKILLS;

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

  test("rejects resetting a non-built-in skill", async () => {
    const manual = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        scope: "org",
        name: "Manual skill",
        description: "desc",
        content: "# manual",
        sourceType: "manual",
      },
      files: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/skills/${manual?.id}/reset`,
    });

    expect(response.statusCode).toBe(400);
  });
});
