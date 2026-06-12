import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { SkillModel, SkillTeamModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";

async function seedImportedSkill(params: {
  organizationId: string;
  name: string;
  sourceRef: string;
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
      sourceType: "github",
      sourceRef: params.sourceRef,
      scope: params.scope,
    },
    files: [],
  });
  if (!skill) throw new Error("seed failed");
  if (params.teamIds?.length) {
    await SkillTeamModel.syncSkillTeams(skill.id, params.teamIds);
  }
  return skill;
}

describe("GET /api/skills/source-repos", () => {
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

  test("non-admins see repositories only for skills within their scope", async ({
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    await makeMember(user.id, organizationId, { role: MEMBER_ROLE_NAME });
    const otherAuthor = await makeUser();
    const team = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id);
    const inaccessibleTeam = await makeTeam(organizationId, otherAuthor.id);

    await seedImportedSkill({
      organizationId,
      name: "org-imported",
      sourceRef: "shared/org-repo@main:SKILL.md",
      scope: "org",
    });
    await seedImportedSkill({
      organizationId,
      name: "own-imported",
      sourceRef: "mine/personal-repo@main:SKILL.md",
      scope: "personal",
      authorId: user.id,
    });
    await seedImportedSkill({
      organizationId,
      name: "team-imported",
      sourceRef: "team/team-repo@main:SKILL.md",
      scope: "team",
      teamIds: [team.id],
    });
    await seedImportedSkill({
      organizationId,
      name: "private-imported",
      sourceRef: "secret/private-repo@main:SKILL.md",
      scope: "personal",
      authorId: otherAuthor.id,
    });
    await seedImportedSkill({
      organizationId,
      name: "inaccessible-team-imported",
      sourceRef: "secret/team-repo@main:SKILL.md",
      scope: "team",
      teamIds: [inaccessibleTeam.id],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/skills/source-repos",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().repos).toEqual([
      "mine/personal-repo",
      "shared/org-repo",
      "team/team-repo",
    ]);
  });

  test("admins see repositories from all skills in the organization", async ({
    makeMember,
    makeUser,
  }) => {
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const otherAuthor = await makeUser();

    await seedImportedSkill({
      organizationId,
      name: "org-imported",
      sourceRef: "shared/org-repo@main:SKILL.md",
      scope: "org",
    });
    await seedImportedSkill({
      organizationId,
      name: "private-imported",
      sourceRef: "secret/private-repo@main:SKILL.md",
      scope: "personal",
      authorId: otherAuthor.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/skills/source-repos",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().repos).toEqual([
      "secret/private-repo",
      "shared/org-repo",
    ]);
  });

  test("non-admins with no accessible imported skills see no repositories", async ({
    makeMember,
    makeUser,
  }) => {
    await makeMember(user.id, organizationId, { role: MEMBER_ROLE_NAME });
    const otherAuthor = await makeUser();

    await seedImportedSkill({
      organizationId,
      name: "private-imported",
      sourceRef: "secret/private-repo@main:SKILL.md",
      scope: "personal",
      authorId: otherAuthor.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/skills/source-repos",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().repos).toEqual([]);
  });
});
