import { SkillModel } from "@/models";
import { describe, expect, test } from "@/test";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import SkillTeamModel from "./skill-team";

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
    },
    files: [],
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

/**
 * Share `scope` with one user by name, or take that share back. Named sharing
 * is a user grant on the object's policy; the retired share rows no longer
 * decide access.
 */
async function setNamedShare(params: {
  organizationId: string;
  scope: string;
  userId: string;
  shared: boolean;
}) {
  const key = {
    organizationId: params.organizationId,
    resource: "skill" as const,
    scope: params.scope,
  };
  const current = await ResourcePermissionPolicyModel.find(key);
  const others = (current?.grants ?? []).filter(
    (grant) =>
      !(grant.subject.type === "user" && grant.subject.id === params.userId),
  );
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: current?.revision ?? 0,
    grants: params.shared
      ? [
          ...others,
          {
            subject: { type: "user", id: params.userId },
            actions: ["read", "use"],
          },
        ]
      : others,
  });
}

describe("SkillUserModel", () => {
  test("a personal skill reaches someone it was shared with by name", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const author = await makeUser();
    const colleague = await makeUser();
    await makeMember(author.id, org.id, { role: "member" });
    await makeMember(colleague.id, org.id, { role: "member" });
    const skill = await seedPersonalSkill({
      organizationId: org.id,
      authorId: author.id,
    });

    const check = (userId: string) =>
      SkillTeamModel.userHasSkillAccess({
        skill,
        userId,
        organizationId: org.id,
      });

    expect(await check(colleague.id)).toBe(false);

    await setNamedShare({
      organizationId: org.id,
      scope: skill.id,
      userId: colleague.id,
      shared: true,
    });

    expect(await check(colleague.id)).toBe(true);
    // Sharing adds; the author keeps access.
    expect(await check(author.id)).toBe(true);
  });

  test("revoking the grant closes access again", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const author = await makeUser();
    const colleague = await makeUser();
    const skill = await seedPersonalSkill({
      organizationId: org.id,
      authorId: author.id,
    });

    await setNamedShare({
      organizationId: org.id,
      scope: skill.id,
      userId: colleague.id,
      shared: true,
    });
    await setNamedShare({
      organizationId: org.id,
      scope: skill.id,
      userId: colleague.id,
      shared: false,
    });

    expect(
      await SkillTeamModel.userHasSkillAccess({
        skill,
        userId: colleague.id,
        organizationId: org.id,
      }),
    ).toBe(false);
  });

  test("a shared personal skill shows up in the grantee's list", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const author = await makeUser();
    const colleague = await makeUser();
    await makeMember(author.id, org.id, { role: "member" });
    await makeMember(colleague.id, org.id, { role: "member" });
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

    await setNamedShare({
      organizationId: org.id,
      scope: skill.id,
      userId: colleague.id,
      shared: true,
    });

    expect(await listFor(colleague.id)).toContain(skill.id);
  });

  test("a grant never crosses organizations", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const otherOrg = await makeOrganization({ legacyPermissions: true });
    const colleague = await makeUser();
    const skill = await seedPersonalSkill({ organizationId: org.id });

    await setNamedShare({
      organizationId: org.id,
      scope: skill.id,
      userId: colleague.id,
      shared: true,
    });

    // Same grant, wrong organization context: still denied.
    expect(
      await SkillTeamModel.userHasSkillAccess({
        skill,
        userId: colleague.id,
        organizationId: otherOrg.id,
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
