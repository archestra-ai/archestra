import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import { SkillModel, SkillTeamModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";

const MANIFEST = [
  "---",
  "name: pdf-processing",
  "description: Extract text from PDF files.",
  "---",
  "",
  "# PDF Processing",
  "Use pdftotext -layout.",
].join("\n");

/** A SKILL.md manifest with a custom name (org+name must be unique). */
function manifestNamed(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: A scoped skill.",
    "---",
    "",
    `# ${name}`,
  ].join("\n");
}

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

describe("PUT /api/skills/:id", () => {
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

  test("updates the manifest and replaces resource files", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [{ path: "references/OLD.md", content: "old" }],
        },
      })
    ).json();

    const updatedManifest = MANIFEST.replace(
      "Extract text from PDF files.",
      "Extract text and tables from PDF files.",
    );
    const response = await app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: {
        content: updatedManifest,
        files: [{ path: "references/NEW.md", content: "new" }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.description).toBe("Extract text and tables from PDF files.");
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe("references/NEW.md");
  });

  test("explicit allowedTools overrides the frontmatter on update", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST, allowedTools: ["Read"] },
      })
    ).json();
    expect(created.allowedTools).toBe("Read");

    const response = await app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: { content: MANIFEST, allowedTools: ["Bash Edit"] },
    });

    expect(response.statusCode).toBe(200);
    // space-separated entries are normalized like the frontmatter form
    expect(response.json().allowedTools).toBe("Bash Edit");

    const cleared = await app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: { content: MANIFEST },
    });
    // omitting the field falls back to the (absent) frontmatter value
    expect(cleared.json().allowedTools).toBeNull();
  });

  test("leaves resource files untouched when `files` is omitted", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [{ path: "references/KEEP.md", content: "keep" }],
        },
      })
    ).json();

    const response = await app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: { content: MANIFEST },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe("references/KEEP.md");
  });

  test("clears resource files when `files` is an empty array", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [{ path: "references/GONE.md", content: "gone" }],
        },
      })
    ).json();

    const response = await app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: { content: MANIFEST, files: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().files).toEqual([]);
  });

  test("a content-only edit does not 403 a team-admin who belongs to only one assigned team", async ({
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    // editor holds skill:team-admin — may manage team-scoped skills
    await makeMember(user.id, organizationId, { role: EDITOR_ROLE_NAME });
    const teamA = await makeTeam(organizationId, user.id);
    const teamB = await makeTeam(organizationId, user.id);
    await makeTeamMember(teamA.id, user.id);

    const skill = await seedImportedSkill({
      organizationId,
      name: "multi-team-skill",
      sourceRef: "x/y@main:SKILL.md",
      scope: "team",
      authorId: user.id,
      teamIds: [teamA.id, teamB.id],
    });

    // a content-only edit that echoes the full team list back must not be
    // rejected just because the author is not a member of every team.
    const response = await app.inject({
      method: "PUT",
      url: `/api/skills/${skill.id}`,
      payload: {
        content: manifestNamed("multi-team-skill"),
        scope: "team",
        teamIds: [teamA.id, teamB.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect((await SkillTeamModel.getTeamsForSkill(skill.id)).sort()).toEqual(
      [teamA.id, teamB.id].sort(),
    );
  });

  test("rejects clearing all teams of a team-scoped skill", async ({
    makeMember,
    makeTeam,
  }) => {
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const team = await makeTeam(organizationId, user.id);
    const skill = await seedImportedSkill({
      organizationId,
      name: "to-be-emptied",
      sourceRef: "x/y@main:SKILL.md",
      scope: "team",
      teamIds: [team.id],
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/skills/${skill.id}`,
      payload: {
        content: manifestNamed("to-be-emptied"),
        scope: "team",
        teamIds: [],
      },
    });

    expect(response.statusCode).toBe(400);
    // the existing assignment is left intact
    expect(await SkillTeamModel.getTeamsForSkill(skill.id)).toEqual([team.id]);
  });
});
