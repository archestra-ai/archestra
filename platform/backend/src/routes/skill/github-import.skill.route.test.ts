import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import {
  GithubAppConfigModel,
  OrganizationModel,
  ServiceAccountModel,
  SkillFileModel,
  SkillModel,
  SkillVersionModel,
} from "@/models";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { secretManager } from "@/secrets-manager";
import { createGithubPat } from "@/services/github-pat";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  STUB_COMMIT_SHA,
  stubGithub,
  stubSkillManifest,
} from "@/test/github-skills-stub";
import skillRoutes from "./skill.routes";
import { useSkillRouteTestApp } from "./skill.test-helpers";

describe("POST /api/skills/github/{discover,preview,import}", () => {
  const ctx = useSkillRouteTestApp(skillRoutes);

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

      // version 1 is exactly the repo's bytes at that commit.
      const v1 = await SkillVersionModel.findBySkillAndVersion(
        body.created[0].id,
        1,
      );
      expect(v1?.sourceCommit).toBe(STUB_COMMIT_SHA);
    });

    test("imports service-account grants on every new skill without sharing skipped skills", async () => {
      const account = await ServiceAccountModel.create({
        organizationId: ctx.organizationId,
        name: "Skill import automation",
        role: "member",
        createdBy: ctx.user.id,
      });
      stubGithub([
        {
          owner: "route-grants",
          repo: "skills",
          files: {
            "first/SKILL.md": stubSkillManifest("import-grant-first"),
            "second/SKILL.md": stubSkillManifest("import-grant-second"),
          },
        },
      ]);
      const grants = [
        {
          subject: { type: "serviceAccount", id: account.id },
          actions: ["read", "use"],
        },
      ];
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/import",
        payload: {
          repoUrl: "route-grants/skills",
          skillPaths: ["first", "second"],
          initialGrants: grants,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().created).toHaveLength(2);
      for (const skill of response.json().created) {
        const policy = await ResourcePermissionPolicyModel.find({
          organizationId: ctx.organizationId,
          resource: "skill",
          scope: skill.id,
        });
        expect(policy?.grants).toEqual(expect.arrayContaining(grants));
        expect(
          policy?.grants.some((grant) => grant.subject.type === "organization"),
        ).toBe(false);
      }
      const retry = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/import",
        payload: {
          repoUrl: "route-grants/skills",
          skillPaths: ["first", "second"],
          initialGrants: [
            {
              subject: { type: "organization", id: "*" },
              actions: ["read", "use"],
            },
          ],
        },
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json().created).toHaveLength(0);
      for (const skill of response.json().created) {
        const policy = await ResourcePermissionPolicyModel.find({
          organizationId: ctx.organizationId,
          resource: "skill",
          scope: skill.id,
        });
        expect(
          policy?.grants.some((grant) => grant.subject.type === "organization"),
        ).toBe(false);
      }
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
    test("creators can choose organization grants during import", async () => {
      stubGithub([
        {
          owner: "route-org-grants",
          repo: "skills",
          files: { "pdf/SKILL.md": stubSkillManifest("org-import") },
        },
      ]);
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills/github/import",
        payload: {
          repoUrl: "route-org-grants/skills",
          skillPaths: ["pdf"],
          scope: "org",
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const policy = await ResourcePermissionPolicyModel.find({
        organizationId: ctx.organizationId,
        resource: "skill",
        scope: response.json().created[0].id,
      });
      expect(policy?.grants).toEqual(
        expect.arrayContaining([
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ]),
      );
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

    test("rejects a malformed githubAppConfigId before it reaches the database", async () => {
      await MemberModel.updateRole(
        ctx.user.id,
        ctx.organizationId,
        EDITOR_ROLE_NAME,
      );
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

    test("404 when the referenced GitHub App config does not exist", async () => {
      // editors (not default members) hold githubAppConfig:read
      await MemberModel.updateRole(
        ctx.user.id,
        ctx.organizationId,
        EDITOR_ROLE_NAME,
      );
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

    test("400 when the GitHub App config targets GitHub Enterprise", async () => {
      await MemberModel.updateRole(
        ctx.user.id,
        ctx.organizationId,
        EDITOR_ROLE_NAME,
      );
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

describe("import sync mode", () => {
  const ctx = useSkillRouteTestApp(skillRoutes);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("defaults to daily sync and persists the tracking ref", async () => {
    stubGithub([
      {
        owner: "sync-default",
        repo: "skills",
        files: { "pdf/SKILL.md": stubSkillManifest("pdf-sync-default") },
      },
    ]);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: {
        repoUrl: "https://github.com/sync-default/skills/tree/main",
        skillPaths: ["pdf"],
      },
    });
    expect(response.statusCode).toBe(200);
    const [created] = response.json().created;
    expect(created.githubSyncInterval).toBe("1d");
    expect(created.githubSyncRef).toBe("main");
    expect(created.githubAppConfigId).toBeNull();
  });

  test("one-time imports no longer exist: sync cannot be null", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: {
        repoUrl: "https://github.com/sync-none/skills",
        skillPaths: ["pdf"],
        sync: null,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  test("a ref-less sync import tracks the default branch (null ref)", async () => {
    stubGithub([
      {
        owner: "sync-headless",
        repo: "skills",
        files: { "pdf/SKILL.md": stubSkillManifest("pdf-sync-headless") },
      },
    ]);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: {
        repoUrl: "https://github.com/sync-headless/skills",
        skillPaths: ["pdf"],
        sync: { interval: "15m" },
      },
    });
    expect(response.statusCode).toBe(200);
    const [created] = response.json().created;
    expect(created.githubSyncInterval).toBe("15m");
    expect(created.githubSyncRef).toBeNull();
  });

  test("rejects a transient token on import (imports are always synced)", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: {
        repoUrl: "https://github.com/sync-pat/skills",
        skillPaths: ["pdf"],
        githubToken: "ghp_secret",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain("never stored");
  });
});

describe("import with a stored PAT", () => {
  const ctx = useSkillRouteTestApp(skillRoutes);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("sync with a saved token is allowed and persists githubPatId", async () => {
    // resolving a stored credential requires githubAppConfig:read
    await MemberModel.updateRole(
      ctx.user.id,
      ctx.organizationId,
      ADMIN_ROLE_NAME,
    );
    const pat = await createGithubPat({
      organizationId: ctx.organizationId,
      data: { name: "skills token", token: "ghp_stored_token" },
    });
    const fetchMock = stubGithub([
      {
        owner: "sync-stored-pat",
        repo: "skills",
        files: { "pdf/SKILL.md": stubSkillManifest("pdf-stored-pat") },
      },
    ]);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: {
        repoUrl: "https://github.com/sync-stored-pat/skills",
        skillPaths: ["pdf"],
        githubPatId: pat.id,
        sync: { interval: "1h" },
      },
    });
    expect(response.statusCode).toBe(200);
    const [created] = response.json().created;
    expect(created.githubSyncInterval).toBe("1h");
    expect(created.githubPatId).toBe(pat.id);
    expect(created.githubAppConfigId).toBeNull();

    // the stored token authenticates the GitHub calls
    const sawToken = fetchMock.mock.calls.some(([, init]) =>
      JSON.stringify(
        (init as { headers?: unknown } | undefined)?.headers ?? {},
      ).includes("ghp_stored_token"),
    );
    expect(sawToken).toBe(true);
  });

  test("rejects combining a stored token with a one-time token", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: {
        repoUrl: "https://github.com/dual-auth/skills",
        skillPaths: ["pdf"],
        githubPatId: "11111111-1111-4111-8111-111111111111",
        githubToken: "ghp_transient",
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("online skill catalog disabled for the organization", () => {
  const ctx = useSkillRouteTestApp(skillRoutes);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await OrganizationModel.patch(ctx.organizationId, {
      onlineSkillCatalogEnabled: false,
    });
  });

  test("discover is refused", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/discover",
      payload: { repoUrl: "catalog-off/skills" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "online skill catalog is disabled",
    );
  });

  test("preview is refused", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/preview",
      payload: { repoUrl: "catalog-off/skills", skillPath: "pdf" },
    });

    expect(response.statusCode).toBe(403);
  });

  test("import is refused, and no skill is persisted", async () => {
    stubGithub([
      {
        owner: "catalog-off",
        repo: "skills",
        files: { "pdf/SKILL.md": stubSkillManifest("catalog-off-skill") },
      },
    ]);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: { repoUrl: "catalog-off/skills", skillPaths: ["pdf"] },
    });

    expect(response.statusCode).toBe(403);
    expect(
      await SkillModel.findAllByName(ctx.organizationId, "catalog-off-skill"),
    ).toEqual([]);
  });

  test("an org admin gets no exemption — the setting is not a permission", async () => {
    await MemberModel.updateRole(
      ctx.user.id,
      ctx.organizationId,
      ADMIN_ROLE_NAME,
    );

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/discover",
      payload: { repoUrl: "catalog-off/skills" },
    });

    expect(response.statusCode).toBe(403);
  });

  test("re-enabling the setting restores the import path", async () => {
    stubGithub([
      {
        owner: "catalog-back-on",
        repo: "skills",
        files: { "pdf/SKILL.md": stubSkillManifest("catalog-back-on-skill") },
      },
    ]);
    await OrganizationModel.patch(ctx.organizationId, {
      onlineSkillCatalogEnabled: true,
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: { repoUrl: "catalog-back-on/skills", skillPaths: ["pdf"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().created).toHaveLength(1);
  });
});
