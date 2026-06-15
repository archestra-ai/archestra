import { EDITOR_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { GithubAppConfigModel, SkillFileModel, SkillModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { afterEach, describe, expect, test, useRouteTestApp } from "@/test";
import {
  STUB_COMMIT_SHA,
  stubGithub,
  stubSkillManifest,
} from "@/test/github-skills-stub";
import skillRoutes from "./skill.routes";

describe("POST /api/skills/github/{discover,preview,import}", () => {
  const ctx = useRouteTestApp(skillRoutes);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The github-import module caches repo snapshots process-wide, so every
  // test below stubs a repo under a distinct owner.
  describe("happy paths (network stubbed)", () => {
    test("import persists a skill with provenance, files, and personal scope", async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
      stubGithub([
        {
          owner: "route-import",
          repo: "skills",
          files: {
            "pdf/SKILL.md": stubSkillManifest("pdf-processing"),
            "pdf/scripts/run.py": "print('hi')",
            "pdf/assets/logo.png": png,
            "pdf/assets/huge.bin": "tree says this is oversized",
          },
          treeSizes: { "pdf/assets/huge.bin": 11 * 1024 * 1024 },
        },
      ]);

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/import",
        payload: { repoUrl: "route-import/skills", skillPaths: ["pdf"] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.skipped).toEqual([]);
      expect(body.skippedFiles).toEqual([
        { skillPath: "pdf", files: ["assets/huge.bin"] },
      ]);
      expect(body.created).toHaveLength(1);
      expect(body.created[0]).toMatchObject({
        name: "pdf-processing",
        sourceType: "github",
        sourceRef: `route-import/skills@${STUB_COMMIT_SHA}:pdf`,
        sourceCommit: STUB_COMMIT_SHA,
        scope: "personal",
        authorId: ctx.user.id,
      });

      const files = await SkillFileModel.findBySkillId(body.created[0].id);
      expect(
        files.map(({ path, encoding, kind }) => ({ path, encoding, kind })),
      ).toEqual([
        { path: "assets/logo.png", encoding: "base64", kind: "asset" },
        { path: "scripts/run.py", encoding: "utf8", kind: "script" },
      ]);
    });

    test("import skips a skill whose name collides and creates the rest", async () => {
      stubGithub([
        {
          owner: "route-collide",
          repo: "skills",
          files: {
            "taken/SKILL.md": stubSkillManifest("already-here"),
            "fresh/SKILL.md": stubSkillManifest("fresh-skill"),
          },
        },
      ]);
      await SkillModel.createWithFiles({
        skill: {
          organizationId: ctx.organizationId,
          authorId: ctx.user.id,
          name: "already-here",
          description: "pre-existing",
          content: "# already-here",
          metadata: {},
          sourceType: "manual",
          scope: "personal",
        },
        files: [],
      });

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/import",
        payload: {
          repoUrl: "route-collide/skills",
          skillPaths: ["taken", "fresh"],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.skipped).toEqual(["already-here"]);
      expect(body.created.map((skill: { name: string }) => skill.name)).toEqual(
        ["fresh-skill"],
      );
    });

    test("discover flags names an import would collide with", async () => {
      stubGithub([
        {
          owner: "route-discover",
          repo: "skills",
          files: {
            "taken/SKILL.md": stubSkillManifest("discover-taken"),
            "free/SKILL.md": stubSkillManifest("discover-free"),
          },
        },
      ]);
      await SkillModel.createWithFiles({
        skill: {
          organizationId: ctx.organizationId,
          authorId: ctx.user.id,
          name: "discover-taken",
          description: "pre-existing",
          content: "# discover-taken",
          metadata: {},
          sourceType: "manual",
          scope: "personal",
        },
        files: [],
      });

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/discover",
        payload: { repoUrl: "route-discover/skills" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(
        body.skills.map(
          ({ name, exists }: { name: string; exists: boolean }) => ({
            name,
            exists,
          }),
        ),
      ).toEqual([
        { name: "discover-taken", exists: true },
        { name: "discover-free", exists: false },
      ]);
    });

    test("preview returns the parsed manifest, files, and provenance without persisting", async () => {
      stubGithub([
        {
          owner: "route-preview",
          repo: "skills",
          files: {
            "s/SKILL.md": stubSkillManifest("preview-skill"),
            "s/references/notes.md": "# notes",
          },
        },
      ]);

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/preview",
        payload: { repoUrl: "route-preview/skills", skillPath: "s" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        name: "preview-skill",
        description: "preview-skill does things.",
        templated: false,
        sourceRef: `route-preview/skills@${STUB_COMMIT_SHA}:s`,
        sourceCommit: STUB_COMMIT_SHA,
      });
      expect(body.files).toEqual([
        {
          path: "references/notes.md",
          content: "# notes",
          encoding: "utf8",
          kind: "reference",
        },
      ]);
      expect(body.skippedFiles).toEqual([]);
      const persisted = await SkillModel.findAllByName(
        ctx.organizationId,
        "preview-skill",
      );
      expect(persisted).toEqual([]);
    });
  });

  describe("scope", () => {
    test("non-admins cannot import skills as org-scoped", async () => {
      // scope is authorized before any GitHub call, so this 403s without network
      const response = await ctx.app.inject({
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

  describe("GitHub App auth for imports", () => {
    test("rejects supplying both githubToken and githubAppConfigId", async () => {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/discover",
        payload: {
          repoUrl: "github.com/example/skills",
          githubToken: "ghp_token",
          githubAppConfigId: "some-id",
        },
      });
      expect(response.statusCode).toBe(400);
    });

    test("rejects a malformed githubAppConfigId before it reaches the database", async ({
      makeMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId, {
        role: EDITOR_ROLE_NAME,
      });
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/discover",
        payload: {
          repoUrl: "github.com/example/skills",
          githubAppConfigId: "not-a-uuid",
        },
      });
      expect(response.statusCode).toBe(400);
    });

    test("403 when the user cannot read GitHub App configs", async () => {
      // the default test user has no githubAppConfig:read permission
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/discover",
        payload: {
          repoUrl: "github.com/example/skills",
          githubAppConfigId: "00000000-0000-0000-0000-000000000000",
        },
      });
      expect(response.statusCode).toBe(403);
    });

    test("404 when the referenced GitHub App config does not exist", async ({
      makeMember,
    }) => {
      // editors (not default members) hold githubAppConfig:read
      await makeMember(ctx.user.id, ctx.organizationId, {
        role: EDITOR_ROLE_NAME,
      });
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/discover",
        payload: {
          repoUrl: "github.com/example/skills",
          githubAppConfigId: "00000000-0000-0000-0000-000000000000",
        },
      });
      expect(response.statusCode).toBe(404);
    });

    test("400 when the GitHub App config targets GitHub Enterprise", async ({
      makeMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId, {
        role: EDITOR_ROLE_NAME,
      });
      const secret = await secretManager().createSecret(
        { apiToken: "pem" },
        "ghes-app",
      );
      const appConfig = await GithubAppConfigModel.create({
        organizationId: ctx.organizationId,
        name: "GHES App",
        githubUrl: "https://github.acme.com/api/v3",
        appId: "1",
        installationId: "1",
        secretId: secret.id,
      });

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/discover",
        payload: {
          repoUrl: "github.com/example/skills",
          githubAppConfigId: appConfig.id,
        },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
