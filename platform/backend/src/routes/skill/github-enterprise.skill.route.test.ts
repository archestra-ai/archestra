import { generateKeyPairSync } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { jwtVerify } from "jose";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import {
  GithubAppConfigModel,
  SkillFileModel,
  SkillModel,
  SkillVersionModel,
} from "@/models";
import { createGithubAppConfig } from "@/services/github-app-config";
import { handleSkillGithubSync } from "@/task-queue/handlers/skill-github-sync-handler";
import { afterEach, describe, expect, test } from "@/test";
import { stubSkillManifest } from "@/test/github-skills-stub";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import skillRoutes from "./skill.routes";

const origin = "https://git.enterprise.example";
const apiBaseUrl = `${origin}/api/v3`;
const firstCommit = "a".repeat(40);
const secondCommit = "b".repeat(40);

// Only HTTP is replaced: routes, secret storage, JWT signing, Octokit,
// persistence, and the recurring-sync handler all execute normally.
describe("Enterprise GitHub App skill import", () => {
  const ctx = useRouteTestApp(skillRoutes);
  const server = useMswServer();

  afterEach(() => {
    vi.useRealTimers();
  });

  test("discovers, previews, imports, and syncs a private Enterprise skill with refreshed credentials", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const appConfig = await createGithubAppConfig({
      organizationId: ctx.organizationId,
      data: {
        name: "Enterprise skills",
        githubUrl: apiBaseUrl,
        appId: "123",
        installationId: "456",
        privateKey: privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
      },
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0x0d, 0x0a]);
    let commit = firstCommit;
    let tokenRequests = 0;
    const repositoryRequests: { url: string; authorization: string | null }[] =
      [];
    const files = () => ({
      "pdf/SKILL.md": `${stubSkillManifest("enterprise-pdf")}\n\n# ${commit === firstCommit ? "First" : "Updated"} body`,
      "pdf/references/notes.md":
        commit === firstCommit ? "Original notes" : "Updated notes",
      "pdf/assets/logo.png": png,
    });
    server.use(
      http.post(
        `${apiBaseUrl}/app/installations/456/access_tokens`,
        async ({ request }) => {
          const jwt = request.headers
            .get("authorization")
            ?.replace(/^Bearer /, "");
          expect(jwt).toBeTruthy();
          const verified = await jwtVerify(jwt ?? "", publicKey, {
            algorithms: ["RS256"],
            issuer: "123",
          });
          expect(verified.payload.exp).toBeGreaterThan(
            Math.floor(Date.now() / 1000),
          );
          tokenRequests += 1;
          return HttpResponse.json({
            token: `ghs_enterprise_${tokenRequests}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          });
        },
      ),
      http.get(
        `${apiBaseUrl}/repos/acme/skills/commits/:ref`,
        ({ request, params }) => {
          repositoryRequests.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
          });
          expect(params.ref).toBe("main");
          return HttpResponse.json({ sha: commit });
        },
      ),
      http.get(
        `${apiBaseUrl}/repos/acme/skills/git/trees/:sha`,
        ({ request, params }) => {
          repositoryRequests.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
          });
          expect(params.sha).toBe(commit);
          return HttpResponse.json({
            sha: commit,
            truncated: false,
            tree: Object.entries(files()).map(([path, content]) => ({
              path,
              type: "blob",
              mode: "100644",
              size: Buffer.byteLength(content),
            })),
          });
        },
      ),
      ...Object.keys(files()).map((filePath) =>
        http.get(
          `${apiBaseUrl}/repos/acme/skills/contents/${filePath}`,
          ({ request }) => {
            repositoryRequests.push({
              url: request.url,
              authorization: request.headers.get("authorization"),
            });
            const url = new URL(request.url);
            expect(url.searchParams.get("ref")).toBe(commit);
            expect(request.headers.get("accept")).toContain("raw");
            const path = decodeURIComponent(
              url.pathname.split("/contents/")[1],
            );
            const content = files()[path as keyof ReturnType<typeof files>];
            if (content === undefined)
              return new HttpResponse(null, { status: 404 });
            return new HttpResponse(
              typeof content === "string" ? content : new Uint8Array(content),
            );
          },
        ),
      ),
    );
    const payload = {
      repoUrl: `${origin}/acme/skills/tree/main`,
      githubAppConfigId: appConfig.id,
    };
    const discovered = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/discover",
      payload,
    });
    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(discovered.json().skills).toEqual([
      expect.objectContaining({
        name: "enterprise-pdf",
        skillPath: "pdf",
        exists: false,
      }),
    ]);

    const preview = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/preview",
      payload: { ...payload, skillPath: "pdf" },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      sourceCommit: firstCommit,
      sourceRef: "acme/skills@main:pdf",
    });
    expect(
      await SkillModel.findAllByName(ctx.organizationId, "enterprise-pdf"),
    ).toEqual([]);

    const imported = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/import",
      payload: {
        ...payload,
        skillPaths: ["pdf"],
        scope: "org",
        sync: { interval: "1d" },
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const [created] = imported.json().created;
    expect(await SkillModel.findById(created.id)).toMatchObject({
      sourceOrigin: origin,
      sourceCommit: firstCommit,
      sourceRef: "acme/skills@main:pdf",
      githubAppConfigId: appConfig.id,
      githubSyncInterval: "1d",
      githubSyncRef: "main",
      scope: "org",
      latestVersion: 1,
    });
    expect(await SkillFileModel.findBySkillId(created.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "assets/logo.png",
          encoding: "base64",
          content: png.toString("base64"),
        }),
        expect.objectContaining({
          path: "references/notes.md",
          content: "Original notes",
        }),
      ]),
    );
    const wrongHost = await ctx.app.inject({
      method: "POST",
      url: "/api/skills/github/discover",
      payload: { ...payload, repoUrl: "https://github.com/acme/skills" },
    });
    expect(wrongHost.statusCode, wrongHost.body).toBe(400);
    expect(wrongHost.json().error.message).toContain(
      `must belong to ${origin}`,
    );
    expect(tokenRequests).toBe(1);
    expect(
      repositoryRequests.every(
        ({ authorization }) =>
          authorization?.toLowerCase() === "token ghs_enterprise_1" ||
          authorization?.toLowerCase() === "bearer ghs_enterprise_1",
      ),
    ).toBe(true);

    // Advance only the clock: real I/O timers remain live. This expires both
    // the repository snapshot and the installation token before the next pull.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    commit = secondCommit;
    repositoryRequests.length = 0;
    await handleSkillGithubSync({ skillId: created.id });
    expect(await SkillModel.findById(created.id)).toMatchObject({
      sourceOrigin: origin,
      sourceCommit: secondCommit,
      githubSyncInterval: "1d",
      scope: "org",
      latestVersion: 2,
      lastSyncError: null,
      content: expect.stringContaining("Updated body"),
    });
    expect(tokenRequests).toBe(2);
    expect(repositoryRequests.length).toBeGreaterThan(0);
    expect(
      repositoryRequests.every(({ authorization }) =>
        authorization?.includes("ghs_enterprise_2"),
      ),
    ).toBe(true);
    const firstVersion = await SkillVersionModel.findBySkillAndVersion(
      created.id,
      1,
    );
    const secondVersion = await SkillVersionModel.findBySkillAndVersion(
      created.id,
      2,
    );
    expect(firstVersion?.sourceCommit).toBe(firstCommit);
    expect(secondVersion?.sourceCommit).toBe(secondCommit);
    expect(await SkillVersionModel.findFiles(secondVersion?.id ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "references/notes.md",
          content: "Updated notes",
        }),
      ]),
    );

    // Changing the saved credential's destination must not silently move an
    // existing source or overwrite its last good content.
    server.use(
      http.post(
        "https://other.enterprise.example/api/v3/app/installations/456/access_tokens",
        () =>
          HttpResponse.json({
            token: "ghs_other_enterprise",
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
      ),
    );
    await GithubAppConfigModel.update(appConfig.id, {
      githubUrl: "https://other.enterprise.example/api/v3",
    });
    repositoryRequests.length = 0;
    await handleSkillGithubSync({ skillId: created.id });
    const afterMismatch = await SkillModel.findById(created.id);
    expect(afterMismatch).toMatchObject({
      sourceOrigin: origin,
      sourceCommit: secondCommit,
      latestVersion: 2,
    });
    expect(afterMismatch?.lastSyncError).toMatch(/host does not match/);
    expect(repositoryRequests).toEqual([]);

    await GithubAppConfigModel.delete(appConfig.id);
    await handleSkillGithubSync({ skillId: created.id });
    const afterDisconnect = await SkillModel.findById(created.id);
    expect(afterDisconnect).toMatchObject({
      sourceOrigin: origin,
      sourceCommit: secondCommit,
      latestVersion: 2,
      content: expect.stringContaining("Updated body"),
    });
    expect(afterDisconnect?.lastSyncError).toBeTruthy();
    expect(repositoryRequests).toEqual([]);
  });

  test("lists and filters identical repository names independently across hosts", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    for (const sourceOrigin of [null, origin]) {
      await SkillModel.createWithFiles({
        skill: {
          organizationId: ctx.organizationId,
          authorId: ctx.user.id,
          name: sourceOrigin ? "enterprise-source" : "public-source",
          description: "A synced skill",
          content: "# Skill",
          metadata: {},
          sourceType: "github",
          sourceRef: `acme/skills@${firstCommit}:pdf`,
          sourceOrigin,
          scope: "org",
        },
        files: [],
      });
    }
    const sources = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/source-repos",
    });
    expect(sources.statusCode, sources.body).toBe(200);
    expect(sources.json().repos.sort()).toEqual(
      ["acme/skills", `${origin}/acme/skills`].sort(),
    );
    for (const [sourceRepo, expectedName] of [
      ["acme/skills", "public-source"],
      [`${origin}/acme/skills`, "enterprise-source"],
    ]) {
      const filtered = await ctx.app.inject({
        method: "GET",
        url: `/api/skills?sourceRepo=${encodeURIComponent(sourceRepo)}`,
      });
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(
        filtered.json().data.map((skill: { name: string }) => skill.name),
      ).toEqual([expectedName]);
    }
  });
});
