import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import { SkillTeamModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillRoutes from "./skill.routes";
import {
  MANIFEST,
  manifestNamed,
  seedImportedSkill,
} from "./skill.test-helpers";

describe("PUT /api/skills/:id", () => {
  const ctx = useRouteTestApp(skillRoutes);

  test("updates the manifest and replaces resource files", async () => {
    const created = (
      await ctx.app.inject({
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
    const response = await ctx.app.inject({
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
      await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST, allowedTools: ["Read"] },
      })
    ).json();
    expect(created.allowedTools).toBe("Read");

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: { content: MANIFEST, allowedTools: ["Bash Edit"] },
    });

    expect(response.statusCode).toBe(200);
    // space-separated entries are normalized like the frontmatter form
    expect(response.json().allowedTools).toBe("Bash Edit");

    const cleared = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: { content: MANIFEST },
    });
    // omitting the field falls back to the (absent) frontmatter value
    expect(cleared.json().allowedTools).toBeNull();
  });

  test("leaves resource files untouched when `files` is omitted", async () => {
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [{ path: "references/KEEP.md", content: "keep" }],
        },
      })
    ).json();

    const response = await ctx.app.inject({
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
      await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [{ path: "references/GONE.md", content: "gone" }],
        },
      })
    ).json();

    const response = await ctx.app.inject({
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
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: EDITOR_ROLE_NAME,
    });
    const teamA = await makeTeam(ctx.organizationId, ctx.user.id);
    const teamB = await makeTeam(ctx.organizationId, ctx.user.id);
    await makeTeamMember(teamA.id, ctx.user.id);

    const skill = await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "multi-team-skill",
      sourceRef: "x/y@main:SKILL.md",
      scope: "team",
      authorId: ctx.user.id,
      teamIds: [teamA.id, teamB.id],
    });

    // a content-only edit that echoes the full team list back must not be
    // rejected just because the author is not a member of every team.
    const response = await ctx.app.inject({
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
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    const skill = await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "to-be-emptied",
      sourceRef: "x/y@main:SKILL.md",
      scope: "team",
      teamIds: [team.id],
    });

    const response = await ctx.app.inject({
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
