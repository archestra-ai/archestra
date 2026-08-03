import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import { EnvironmentModel, SkillModel, SkillTeamModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillRoutes from "./skill.routes";
import {
  MANIFEST,
  manifestNamed,
  seedImportedSkill,
} from "./skill.test-helpers";

describe("PUT /api/skills/:id", () => {
  const ctx = useRouteTestApp(skillRoutes);

  test("replaces a skill's environment assignments", async () => {
    const skill = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      })
    ).json();
    const staging = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "Staging",
    });
    const production = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "Production",
    });

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skill.id}`,
      payload: {
        content: MANIFEST,
        environmentIds: [staging.id, production.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .environments.map((e: { id: string }) => e.id)
        .sort(),
    ).toEqual([production.id, staging.id].sort());

    // omitting environmentIds leaves the assignments untouched...
    const untouched = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skill.id}`,
      payload: { content: MANIFEST },
    });
    expect(untouched.statusCode).toBe(200);
    expect(untouched.json().environments).toHaveLength(2);

    // ...and an explicit [] clears them (available in every environment).
    const cleared = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skill.id}`,
      payload: { content: MANIFEST, environmentIds: [] },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().environments).toEqual([]);
  });

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

  test("baseVersion rejects an edit composed from a superseded head", async () => {
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      })
    ).json();
    expect(created.latestVersion).toBe(1);

    // Only the body and resource files are versioned, so a fork needs a body
    // edit — changing frontmatter alone would leave the head where it is.
    const bodyAt = (text: string) =>
      MANIFEST.replace("Use pdftotext -layout.", text);

    // An edit anchored to the head it was composed from goes through and forks.
    const first = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: { content: bodyAt("First edit."), baseVersion: 1 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().latestVersion).toBe(2);

    // A second edit still anchored to version 1 was composed before that fork,
    // so it is rejected instead of burying it.
    const stale = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: { content: bodyAt("Stale edit."), baseVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
    // A name collision is a 409 on this route too, so the compare-and-set
    // carries a code that tells the two apart — a client showing "reopen and
    // reapply" must not show it for a taken name.
    expect(stale.json().error.internal_code).toBe("skill_version_conflict");

    // The rejected write rolled back: the skill still reads as the first edit.
    const current = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/skills/${created.id}`,
      })
    ).json();
    expect(current.latestVersion).toBe(2);
    expect(current.content).toContain("First edit.");
  });

  test("omitting baseVersion keeps last-write-wins", async () => {
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      })
    ).json();
    await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: {
        content: MANIFEST.replace("Use pdftotext -layout.", "Second."),
      },
    });

    // No anchor, so a self-contained manifest edit overwrites whatever is there.
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: {
        content: MANIFEST.replace("Use pdftotext -layout.", "Third."),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().content).toContain("Third.");
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

describe("PUT /api/skills/:id on a GitHub-synced skill", () => {
  const ctx = useRouteTestApp(skillRoutes);

  async function seedSynced() {
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        name: "synced-locked",
        description: "synced-locked description",
        content: "# body",
        metadata: {},
        sourceType: "github",
        sourceRef: "acme/skills@main:synced-locked",
        sourceCommit: "abc",
        scope: "personal",
        githubSyncInterval: "1d",
      },
      files: [],
    });
    if (!skill) throw new Error("seed failed");
    return skill;
  }

  const echoManifest = [
    "---",
    "name: synced-locked",
    "description: synced-locked description",
    "---",
    "",
    "# body",
  ].join("\n");

  test("rejects a content change with 409", async () => {
    const skill = await seedSynced();
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skill.id}`,
      payload: { content: `${echoManifest}\nedited` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("synced from GitHub");
  });

  test("rejects a files change with 409", async () => {
    const skill = await seedSynced();
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skill.id}`,
      payload: {
        content: echoManifest,
        files: [{ path: "references/x.md", content: "# X" }],
      },
    });
    expect(response.statusCode).toBe(409);
  });

  test("allows a settings-only save that echoes the manifest", async () => {
    const skill = await seedSynced();
    const env = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "Sync Staging",
    });
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skill.id}`,
      payload: { content: echoManifest, environmentIds: [env.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().environments).toEqual([
      { id: env.id, name: "Sync Staging" },
    ]);
    // still synced, still at version 1 — nothing content-wise changed
    expect(response.json().githubSyncInterval).toBe("1d");
    expect(response.json().latestVersion).toBe(1);
  });
});
