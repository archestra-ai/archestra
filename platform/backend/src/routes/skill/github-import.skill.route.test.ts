import { EDITOR_ROLE_NAME } from "@archestra/shared";
import { GithubAppConfigModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillRoutes from "./skill.routes";

describe("POST /api/skills/github/{discover,preview,import}", () => {
  const ctx = useRouteTestApp(skillRoutes);

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
