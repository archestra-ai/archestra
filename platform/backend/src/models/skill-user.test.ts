import { SkillModel } from "@/models";
import { describe, expect, test } from "@/test";
import SkillTeamModel from "./skill-team";
import SkillUserModel from "./skill-user";

async function seedPersonalSkill(params: {
  organizationId: string;
  authorId?: string | null;
}) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: params.authorId ?? null,
      name: `skill-${Math.random().toString(36).slice(2, 8)}`,
      description: "shared-with-users fixture",
      content: "# fixture",
      metadata: {},
      sourceType: "manual",
      scope: "personal",
    },
    files: [],
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

describe("SkillUserModel", () => {
  test("a personal skill reaches someone it was shared with by name", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const colleague = await makeUser();
    const skill = await seedPersonalSkill({
      organizationId: org.id,
      authorId: author.id,
    });

    const check = (userId: string) =>
      SkillTeamModel.userHasSkillAccess({
        skill,
        userId,
        organizationId: org.id,
        isSkillAdmin: false,
      });

    expect(await check(colleague.id)).toBe(false);

    await SkillUserModel.syncSkillUsers(skill.id, [colleague.id]);

    expect(await check(colleague.id)).toBe(true);
    // Sharing adds; the author keeps access.
    expect(await check(author.id)).toBe(true);
  });

  test("revoking the grant closes access again", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const colleague = await makeUser();
    const skill = await seedPersonalSkill({
      organizationId: org.id,
      authorId: author.id,
    });

    await SkillUserModel.syncSkillUsers(skill.id, [colleague.id]);
    await SkillUserModel.syncSkillUsers(skill.id, []);

    expect(
      await SkillTeamModel.userHasSkillAccess({
        skill,
        userId: colleague.id,
        organizationId: org.id,
        isSkillAdmin: false,
      }),
    ).toBe(false);
  });

  test("a shared personal skill shows up in the grantee's list", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const colleague = await makeUser();
    const skill = await seedPersonalSkill({
      organizationId: org.id,
      authorId: author.id,
    });

    const listFor = (userId: string) =>
      SkillTeamModel.getUserAccessibleSkillIds({
        organizationId: org.id,
        userId,
      });

    expect(await listFor(colleague.id)).not.toContain(skill.id);

    await SkillUserModel.syncSkillUsers(skill.id, [colleague.id]);

    expect(await listFor(colleague.id)).toContain(skill.id);
  });

  test("a grant never crosses organizations", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const colleague = await makeUser();
    const skill = await seedPersonalSkill({ organizationId: org.id });

    await SkillUserModel.syncSkillUsers(skill.id, [colleague.id]);

    // Same grant, wrong organization context: still denied.
    expect(
      await SkillTeamModel.userHasSkillAccess({
        skill,
        userId: colleague.id,
        organizationId: otherOrg.id,
        isSkillAdmin: false,
      }),
    ).toBe(false);
    expect(
      await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId: otherOrg.id,
        userId: colleague.id,
      }),
    ).not.toContain(skill.id);
  });
});
