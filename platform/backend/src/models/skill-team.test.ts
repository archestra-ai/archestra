import { SkillModel, SkillTeamModel } from "@/models";
import { describe, expect, test } from "@/test";
import type { ResourceVisibilityScope } from "@/types/visibility";

async function seedSkill(params: {
  organizationId: string;
  name: string;
  scope: ResourceVisibilityScope;
  authorId?: string | null;
  teamIds?: string[];
}) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: params.authorId ?? null,
      name: params.name,
      description: `${params.name} description`,
      content: `# ${params.name}`,
      metadata: {},
      sourceType: "manual",
      scope: params.scope,
    },
    files: [],
    teamIds: params.teamIds,
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

describe("SkillTeamModel.getUserAccessibleSkillIds", () => {
  test("returns org skills, own personal skills, and team skills", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const other = await makeUser();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);

    const orgSkill = await seedSkill({
      organizationId: org.id,
      name: "org-skill",
      scope: "org",
    });
    const ownSkill = await seedSkill({
      organizationId: org.id,
      name: "own-skill",
      scope: "personal",
      authorId: user.id,
    });
    const teamSkill = await seedSkill({
      organizationId: org.id,
      name: "team-skill",
      scope: "team",
      teamIds: [team.id],
    });
    const othersPersonal = await seedSkill({
      organizationId: org.id,
      name: "others-skill",
      scope: "personal",
      authorId: other.id,
    });

    const accessible = new Set(
      await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId: org.id,
        userId: user.id,
      }),
    );

    expect(accessible.has(orgSkill.id)).toBe(true);
    expect(accessible.has(ownSkill.id)).toBe(true);
    expect(accessible.has(teamSkill.id)).toBe(true);
    expect(accessible.has(othersPersonal.id)).toBe(false);
  });

  test("excludes team skills for non-members", async ({
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const outsider = await makeUser();
    const team = await makeTeam(org.id, owner.id);

    const teamSkill = await seedSkill({
      organizationId: org.id,
      name: "team-skill",
      scope: "team",
      teamIds: [team.id],
    });

    const accessible = new Set(
      await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId: org.id,
        userId: outsider.id,
      }),
    );
    expect(accessible.has(teamSkill.id)).toBe(false);
  });

  test("without a userId returns only org-scoped skills", async ({
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const team = await makeTeam(org.id, author.id);

    const orgSkill = await seedSkill({
      organizationId: org.id,
      name: "org-skill",
      scope: "org",
    });
    const personalSkill = await seedSkill({
      organizationId: org.id,
      name: "personal-skill",
      scope: "personal",
      authorId: author.id,
    });
    const teamSkill = await seedSkill({
      organizationId: org.id,
      name: "team-skill",
      scope: "team",
      teamIds: [team.id],
    });

    const accessible = new Set(
      await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId: org.id,
      }),
    );
    expect(accessible.has(orgSkill.id)).toBe(true);
    expect(accessible.has(personalSkill.id)).toBe(false);
    expect(accessible.has(teamSkill.id)).toBe(false);
  });

  test("does not return another organization's org skills", async ({
    makeOrganization,
    makeUser,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const user = await makeUser();

    const orgSkillA = await seedSkill({
      organizationId: orgA.id,
      name: "org-skill",
      scope: "org",
    });

    const accessible = new Set(
      await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId: orgB.id,
        userId: user.id,
      }),
    );
    expect(accessible.has(orgSkillA.id)).toBe(false);
  });
});

describe("SkillTeamModel.userHasSkillAccess", () => {
  test("org skills are accessible to everyone", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill({
      organizationId: org.id,
      name: "org-skill",
      scope: "org",
    });

    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        userId: user.id,
        skill,
        isSkillAdmin: false,
      }),
    ).toBe(true);
  });

  test("personal skills are accessible only to the author", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const other = await makeUser();
    const skill = await seedSkill({
      organizationId: org.id,
      name: "personal-skill",
      scope: "personal",
      authorId: author.id,
    });

    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        userId: author.id,
        skill,
        isSkillAdmin: false,
      }),
    ).toBe(true);
    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        userId: other.id,
        skill,
        isSkillAdmin: false,
      }),
    ).toBe(false);
    // admins bypass scope
    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        userId: other.id,
        skill,
        isSkillAdmin: true,
      }),
    ).toBe(true);
  });

  test("team skills are accessible only to team members", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    const outsider = await makeUser();
    const team = await makeTeam(org.id, member.id);
    await makeTeamMember(team.id, member.id);

    const skill = await seedSkill({
      organizationId: org.id,
      name: "team-skill",
      scope: "team",
      teamIds: [team.id],
    });

    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        userId: member.id,
        skill,
        isSkillAdmin: false,
      }),
    ).toBe(true);
    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        userId: outsider.id,
        skill,
        isSkillAdmin: false,
      }),
    ).toBe(false);
  });

  test("a skill from another organization is never accessible", async ({
    makeOrganization,
    makeUser,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const user = await makeUser();
    const orgSkillA = await seedSkill({
      organizationId: orgA.id,
      name: "org-skill",
      scope: "org",
    });

    // an org-scoped skill is open within its org but never cross-org, even
    // for an admin.
    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: orgB.id,
        userId: user.id,
        skill: orgSkillA,
        isSkillAdmin: true,
      }),
    ).toBe(false);
  });

  test("without a userId only org-scoped skills are accessible", async ({
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const team = await makeTeam(org.id, author.id);

    const orgSkill = await seedSkill({
      organizationId: org.id,
      name: "org-skill",
      scope: "org",
    });
    const personalSkill = await seedSkill({
      organizationId: org.id,
      name: "personal-skill",
      scope: "personal",
      authorId: author.id,
    });
    const teamSkill = await seedSkill({
      organizationId: org.id,
      name: "team-skill",
      scope: "team",
      teamIds: [team.id],
    });

    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        skill: orgSkill,
        isSkillAdmin: false,
      }),
    ).toBe(true);
    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        skill: personalSkill,
        isSkillAdmin: false,
      }),
    ).toBe(false);
    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        skill: teamSkill,
        isSkillAdmin: false,
      }),
    ).toBe(false);
  });
});
