import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { SkillModel, SkillTeamModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { MAX_SKILL_FILE_BYTES } from "@/skills/github-import";
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

describe("skill routes", () => {
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

    const { default: skillRoutes } = await import("./skill");
    await app.register(skillRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /api/skills", () => {
    test("creates a skill from a SKILL.md manifest", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe("pdf-processing");
      expect(body.description).toBe("Extract text from PDF files.");
      expect(body.content).toContain("# PDF Processing");
      expect(body.sourceType).toBe("manual");
      expect(body.authorId).toBe(user.id);
      expect(body.files).toEqual([]);
    });

    test("stores resource files with derived kinds", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [
            { path: "references/FORMS.md", content: "# Forms" },
            { path: "scripts/run.py", content: "print(1)" },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const files = response.json().files;
      expect(files).toHaveLength(2);
      const byPath = Object.fromEntries(
        files.map((f: { path: string; kind: string }) => [f.path, f.kind]),
      );
      expect(byPath["references/FORMS.md"]).toBe("reference");
      expect(byPath["scripts/run.py"]).toBe("script");
    });

    test("rejects a manifest with no frontmatter", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: "# no frontmatter" },
      });

      expect(response.statusCode).toBe(400);
    });

    test("rejects a duplicate skill name", async () => {
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      });

      expect(response.statusCode).toBe(409);
    });

    test("rejects duplicate resource file paths with a 400", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [
            { path: "references/FORMS.md", content: "# Forms" },
            { path: "references/FORMS.md", content: "# Dup" },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test("rejects a manifest larger than the size cap", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST + "x".repeat(MAX_SKILL_FILE_BYTES) },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/skills", () => {
    test("lists skills with a resource file count", async () => {
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [{ path: "references/FORMS.md", content: "# Forms" }],
        },
      });

      const response = await app.inject({ method: "GET", url: "/api/skills" });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].fileCount).toBe(1);
    });
  });

  describe("GET /api/skills/source-repos", () => {
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

  describe("PUT /api/skills/:id", () => {
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
      expect(await SkillTeamModel.getTeamsForSkill(skill.id)).toEqual([
        team.id,
      ]);
    });
  });

  describe("DELETE /api/skills/:id", () => {
    test("deletes a skill", async () => {
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/skills",
          payload: { content: MANIFEST },
        })
      ).json();

      const response = await app.inject({
        method: "DELETE",
        url: `/api/skills/${created.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });

      const getResponse = await app.inject({
        method: "GET",
        url: `/api/skills/${created.id}`,
      });
      expect(getResponse.statusCode).toBe(404);
    });
  });

  describe("scope", () => {
    test("a new skill defaults to personal scope owned by the author", async () => {
      const body = (
        await app.inject({
          method: "POST",
          url: "/api/skills",
          payload: { content: MANIFEST },
        })
      ).json();

      expect(body.scope).toBe("personal");
      expect(body.authorId).toBe(user.id);
      expect(body.teams).toEqual([]);
    });

    test("non-admins cannot create an org-scoped skill", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST, scope: "org" },
      });

      expect(response.statusCode).toBe(403);
    });

    test("admins can create an org-scoped skill", async ({ makeMember }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST, scope: "org" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().scope).toBe("org");
    });

    test("team-admins can only assign teams they belong to", async ({
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      await makeMember(user.id, organizationId, { role: EDITOR_ROLE_NAME });
      const ownTeam = await makeTeam(organizationId, user.id);
      await makeTeamMember(ownTeam.id, user.id);
      const foreignTeam = await makeTeam(organizationId, user.id);

      const ok = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: manifestNamed("team-skill"),
          scope: "team",
          teamIds: [ownTeam.id],
        },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().teams).toHaveLength(1);

      const denied = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: manifestNamed("foreign-team-skill"),
          scope: "team",
          teamIds: [foreignTeam.id],
        },
      });
      expect(denied.statusCode).toBe(403);
    });

    test("rejects a team-scoped skill with an unknown team id without orphaning it", async ({
      makeMember,
    }) => {
      // admins bypass the team-membership check, so an unknown id reaches the
      // existence validation rather than 403-ing first.
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: manifestNamed("orphan-check"),
          scope: "team",
          teamIds: ["does-not-exist"],
        },
      });

      expect(response.statusCode).toBe(400);
      // the skill row must not have been committed
      expect(
        await SkillModel.findByName(organizationId, "orphan-check"),
      ).toBeNull();
    });

    test("persists team assignments atomically with the skill", async ({
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      await makeMember(user.id, organizationId, { role: EDITOR_ROLE_NAME });
      const team = await makeTeam(organizationId, user.id);
      await makeTeamMember(team.id, user.id);

      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: manifestNamed("atomic-team-skill"),
          scope: "team",
          teamIds: [team.id],
        },
      });

      expect(response.statusCode).toBe(200);
      const created = response.json();
      expect(await SkillTeamModel.getTeamsForSkill(created.id)).toEqual([
        team.id,
      ]);
    });

    test("rejects a team-scoped skill created with no teams", async ({
      makeMember,
    }) => {
      // admins bypass the team-membership check, so an empty team list is not
      // caught there — the explicit team validation must reject it.
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

      const response = await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: manifestNamed("teamless-skill"),
          scope: "team",
          teamIds: [],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(
        await SkillModel.findByName(organizationId, "teamless-skill"),
      ).toBeNull();
    });

    test("a personal skill is hidden from non-authors", async ({
      makeUser,
    }) => {
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

    test("non-admins cannot import skills as org-scoped", async () => {
      // scope is authorized before any GitHub call, so this 403s without network
      const response = await app.inject({
        method: "POST",
        url: "/api/skills/github/import",
        payload: {
          repoUrl: "github.com/example/skills",
          skillPaths: ["pdf-processing"],
          scope: "org",
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
