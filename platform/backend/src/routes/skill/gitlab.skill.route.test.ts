import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { SkillFileModel, SkillModel } from "@/models";
import { createGitlabToken } from "@/services/git-credentials";
import { handleSkillGithubSync } from "@/task-queue/handlers/skill-github-sync-handler";
import { describe, expect, test } from "@/test";
import { FakeGitlab } from "@/test/fake-gitlab";
import { stubSkillManifest } from "@/test/github-skills-stub";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import skillRoutes from "./skill.routes";

const GITLAB = "https://gitlab.example.test";
const TOKEN = "glpat-skills";

// Only HTTP is replaced, by an in-memory GitLab: routes, secret storage,
// persistence and the recurring-sync handler run for real.
describe("GitLab skill import", () => {
  const ctx = useRouteTestApp(skillRoutes);
  const server = useMswServer();

  test("imports skills nested under groups from a self-managed GitLab and keeps them in sync", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const gitlab = new FakeGitlab(GITLAB, TOKEN);
    server.use(...gitlab.handlers());
    const project = gitlab.addProject({
      path: "platform/ai/skill-hub",
      files: {
        "skills/security/appsec/threat-model/SKILL.md": `${stubSkillManifest("threat-model")}\n\nFirst body`,
        "skills/security/appsec/threat-model/references/checklist.md":
          "Original checklist",
        "skills/docs/writing/style-guide/SKILL.md":
          stubSkillManifest("style-guide"),
        "README.md": "# Skill hub",
      },
    });
    const credential = await createGitlabToken({
      organizationId: ctx.organizationId,
      data: { name: "Skill hub", gitlabUrl: GITLAB, token: TOKEN },
    });
    const payload = {
      repoUrl: `${GITLAB}/platform/ai/skill-hub/-/tree/main/skills`,
      provider: "gitlab",
      gitlabTokenId: credential.id,
    };

    const discovered = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/discover",
      payload,
    });
    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(
      discovered
        .json()
        .skills.map((skill: { skillPath: string }) => skill.skillPath)
        .sort(),
    ).toEqual([
      "skills/docs/writing/style-guide",
      "skills/security/appsec/threat-model",
    ]);

    const imported = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: {
        ...payload,
        skillPaths: ["skills/security/appsec/threat-model"],
        sync: { interval: "1d" },
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const [created] = imported.json().created;
    const firstCommit = project.branches.get("main");
    expect(await SkillModel.findById(created.id)).toMatchObject({
      sourceProvider: "gitlab",
      sourceOrigin: GITLAB,
      sourceCommit: firstCommit,
      sourceRef:
        "platform/ai/skill-hub@main:skills/security/appsec/threat-model",
      gitlabTokenId: credential.id,
      githubSyncRef: "main",
      latestVersion: 1,
    });
    expect(await SkillFileModel.findBySkillId(created.id)).toEqual([
      expect.objectContaining({
        path: "references/checklist.md",
        content: "Original checklist",
      }),
    ]);

    // A push to the tracked branch lands on the next scheduled pull.
    gitlab.addProject({
      path: "platform/ai/skill-hub",
      files: {
        "skills/security/appsec/threat-model/SKILL.md": `${stubSkillManifest("threat-model")}\n\nUpdated body`,
        "skills/security/appsec/threat-model/references/checklist.md":
          "Updated checklist",
      },
    });
    // Right after the import, inside the snapshot cache window: a sync still
    // reads the branch as it is now.
    await handleSkillGithubSync({ skillId: created.id });
    expect(await SkillModel.findById(created.id)).toMatchObject({
      latestVersion: 2,
      lastSyncError: null,
      content: expect.stringContaining("Updated body"),
    });
    expect(gitlab.requests.every((request) => request.path.length > 0)).toBe(
      true,
    );
  });

  test("moves a synced skill to another project and folder, and refuses a location without it", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const gitlab = new FakeGitlab(GITLAB, TOKEN);
    server.use(...gitlab.handlers());
    gitlab.addProject({
      path: "platform/skill-hub",
      files: {
        "skills/style-guide/SKILL.md": stubSkillManifest("style-guide"),
      },
    });
    const moved = gitlab.addProject({
      path: "docs/writing",
      files: {
        "guides/style-guide/SKILL.md": `${stubSkillManifest("style-guide")}\n\nNew home`,
      },
    });
    const credential = await createGitlabToken({
      organizationId: ctx.organizationId,
      data: { name: "Skill hub", gitlabUrl: GITLAB, token: TOKEN },
    });
    const imported = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: {
        repoUrl: `${GITLAB}/platform/skill-hub`,
        provider: "gitlab",
        gitlabTokenId: credential.id,
        skillPaths: ["skills/style-guide"],
      },
    });
    const [skill] = imported.json().created;
    const editSource = (source: Record<string, unknown>) =>
      ctx.app.inject({
        method: "PATCH",
        url: `/api/skills/${skill.id}/github-sync`,
        payload: {
          interval: "1h",
          source: {
            repoUrl: `${GITLAB}/docs/writing`,
            provider: "gitlab",
            gitlabTokenId: credential.id,
            ...source,
          },
        },
      });

    // Nothing there: refused, and the skill keeps its source.
    const missing = await editSource({ skillPath: "guides/nope" });
    expect(missing.statusCode).toBe(400);
    expect(await SkillModel.findById(skill.id)).toMatchObject({
      sourceRef: expect.stringMatching(/^platform\/skill-hub@/),
      githubSyncInterval: "1d",
    });

    const response = await editSource({ skillPath: "guides/style-guide" });
    expect(response.statusCode, response.body).toBe(200);
    expect(await SkillModel.findById(skill.id)).toMatchObject({
      sourceRef: `docs/writing@${moved.branches.get("main")}:guides/style-guide`,
      sourceOrigin: GITLAB,
      gitlabTokenId: credential.id,
      githubSyncInterval: "1h",
      lastSyncError: null,
      latestVersion: 2,
      content: expect.stringContaining("New home"),
    });

    // Stopping the sync drops the stored GitLab token with the rest.
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/github-sync`,
      payload: { disconnect: true },
    });
    expect(await SkillModel.findById(skill.id)).toMatchObject({
      githubSyncInterval: null,
      gitlabTokenId: null,
    });
  });

  test("refuses a self-managed GitLab without a saved token before any request", async () => {
    const gitlab = new FakeGitlab(GITLAB, TOKEN);
    server.use(...gitlab.handlers());

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/discover",
      payload: {
        repoUrl: `${GITLAB}/platform/skill-hub`,
        provider: "gitlab",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(gitlab.requests).toHaveLength(0);
  });
});
