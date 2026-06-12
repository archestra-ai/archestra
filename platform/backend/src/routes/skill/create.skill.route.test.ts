import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import { SkillModel, SkillTeamModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { MAX_SKILL_FILE_BYTES } from "@/skills/github-import";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

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

describe("POST /api/skills", () => {
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

  test("derives allowedTools from frontmatter when the payload omits it", async () => {
    const manifest = [
      "---",
      "name: pdf-processing",
      "description: Extract text from PDF files.",
      "allowed-tools: Read Bash",
      "---",
      "",
      "# PDF Processing",
    ].join("\n");
    const response = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: manifest },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().allowedTools).toBe("Read Bash");
  });

  test("explicit allowedTools overrides the frontmatter", async () => {
    const manifest = [
      "---",
      "name: pdf-processing",
      "description: Extract text from PDF files.",
      "allowed-tools: Read",
      "---",
      "",
      "# PDF Processing",
    ].join("\n");
    const response = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: manifest, allowedTools: ["Bash", "Edit"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().allowedTools).toBe("Bash Edit");
  });

  test("an empty allowedTools array clears the frontmatter value", async () => {
    const manifest = [
      "---",
      "name: pdf-processing",
      "description: Extract text from PDF files.",
      "allowed-tools: Read",
      "---",
      "",
      "# PDF Processing",
    ].join("\n");
    const response = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: manifest, allowedTools: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().allowedTools).toBeNull();
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
  });
});
