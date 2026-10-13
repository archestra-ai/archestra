import { generateKeyPairSync } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import config from "@/config";
import { PluginModel } from "@/models";
import { createGitlabToken } from "@/services/git-credentials";
import { createGithubAppConfig } from "@/services/github-app-config";
import { handlePluginGithubSync } from "@/task-queue/handlers/plugin-github-sync-handler";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import { grantEverywhere } from "@/test/wildcard-grants";
import pluginRoutes from "./plugin.routes";

const COMMIT = "c".repeat(40);
const NEXT_COMMIT = "d".repeat(40);

// Only HTTP is replaced: routes, credential storage, GitHub App token minting,
// the shared Git host client, persistence, and the sync handler all run.
describe("plugin imports from GitLab and self-hosted GitHub", () => {
  const ctx = useRouteTestApp(pluginRoutes);
  const server = useMswServer();

  beforeEach(() => {
    config.plugins.enabled = true;
    grantEverywhere(["plugin"]);
  });

  test("imports a public gitlab.com plugin folder without a credential", async () => {
    const gitlab = fakeGitlab({
      webUrl: "https://gitlab.com",
      projects: {
        "acme/plugins": {
          "plugins/lint/hooks/hooks.json": '{ "hooks": {} }\n',
          "plugins/lint/scripts/run.sh": "#!/bin/sh\ntrue\n",
          "README.md": "outside the folder\n",
        },
      },
      modes: { "plugins/lint/scripts/run.sh": "100755" },
    });
    server.use(...gitlab.handlers);
    const source = {
      provider: "gitlab",
      repoUrl: "https://gitlab.com/acme/plugins/-/tree/main/plugins/lint",
    };

    const preview = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/preview",
      payload: source,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      repo: "acme/plugins",
      sourceProvider: "gitlab",
      sourceOrigin: null,
      requestedRef: "main",
      commitSha: COMMIT,
      subdir: "plugins/lint",
    });
    expect(preview.json().files).toEqual([
      expect.objectContaining({ path: "hooks/hooks.json", mode: "100644" }),
      expect.objectContaining({ path: "scripts/run.sh", mode: "100755" }),
    ]);

    const imported = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/import",
      payload: {
        ...source,
        displayName: "Lint",
        clientType: "claude-code",
        approvedCommitSha: COMMIT,
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json()).toMatchObject({
      sourceKind: "github",
      sourceProvider: "gitlab",
      sourceOrigin: null,
      sourceRepo: "acme/plugins",
      sourceSubdir: "plugins/lint",
      sourceRef: "main",
      sourceSha: COMMIT,
      gitlabTokenId: null,
    });
    expect(gitlab.requests.length).toBeGreaterThan(0);
    expect(gitlab.requests.every((request) => !request.token)).toBe(true);
  });

  test("imports and syncs a nested self-managed GitLab project through a saved token", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const gitlab = fakeGitlab({
      webUrl: "https://gitlab.example.test",
      token: "glpat-plugins",
      projects: {
        "platform/tools/plugins": {
          "review/agents/reviewer.md": "Review changes.\n",
        },
      },
    });
    server.use(...gitlab.handlers);
    const token = await createGitlabToken({
      organizationId: ctx.organizationId,
      data: {
        name: "Self-managed GitLab",
        gitlabUrl: "https://gitlab.example.test",
        token: "glpat-plugins",
      },
    });

    const imported = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/import",
      payload: {
        repoUrl: "https://gitlab.example.test/platform/tools/plugins",
        subdir: "review",
        gitlabTokenId: token.id,
        displayName: "Reviewer",
        clientType: "claude-code",
        approvedCommitSha: COMMIT,
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json()).toMatchObject({
      sourceProvider: "gitlab",
      sourceOrigin: "https://gitlab.example.test",
      sourceRepo: "platform/tools/plugins",
      sourceSubdir: "review",
      gitlabTokenId: token.id,
      files: [expect.objectContaining({ path: "agents/reviewer.md" })],
    });
    expect(
      gitlab.requests.some((request) =>
        request.url.includes("/projects/platform%2Ftools%2Fplugins/"),
      ),
    ).toBe(true);
    expect(
      gitlab.requests.every((request) => request.token === "glpat-plugins"),
    ).toBe(true);

    // The scheduled check reads the same host with the stored token and
    // records a pinned candidate without replacing the approved bytes.
    gitlab.setCommit(NEXT_COMMIT);
    const plugin = imported.json();
    await PluginModel.setGithubSync({ id: plugin.id, interval: "1h" });
    await handlePluginGithubSync({ pluginId: plugin.id });
    expect(
      await PluginModel.findById({
        id: plugin.id,
        organizationId: ctx.organizationId,
      }),
    ).toMatchObject({
      sourceSha: COMMIT,
      pendingSourceSha: NEXT_COMMIT,
      lastSyncError: null,
    });
  });

  test("imports from GitHub Enterprise Server through a GitHub App", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const apiUrl = "https://ghe.example.test/api/v3";
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const app = await createGithubAppConfig({
      organizationId: ctx.organizationId,
      data: {
        name: "Enterprise plugins",
        githubUrl: apiUrl,
        appId: "123",
        installationId: "456",
        privateKey: privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
      },
    });
    const files: Record<string, string> = {
      "hooks/hooks.json": "{}\n",
      "scripts/run.sh": "#!/bin/sh\ntrue\n",
    };
    const authorizations: (string | null)[] = [];
    server.use(
      http.post(`${apiUrl}/app/installations/456/access_tokens`, () =>
        HttpResponse.json({
          token: "ghs_enterprise",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      ),
      http.get(`${apiUrl}/repos/acme/plugin/commits/:ref`, ({ request }) => {
        authorizations.push(request.headers.get("authorization"));
        return HttpResponse.json({ sha: COMMIT });
      }),
      http.get(`${apiUrl}/repos/acme/plugin/git/trees/:sha`, ({ request }) => {
        authorizations.push(request.headers.get("authorization"));
        return HttpResponse.json({
          sha: COMMIT,
          truncated: false,
          tree: Object.entries(files).map(([path, content]) => ({
            path,
            type: "blob",
            mode: path.endsWith(".sh") ? "100755" : "100644",
            size: Buffer.byteLength(content),
          })),
        });
      }),
      ...Object.keys(files).map((filePath) =>
        http.get(
          `${apiUrl}/repos/acme/plugin/contents/${filePath}`,
          ({ request }) => {
            authorizations.push(request.headers.get("authorization"));
            expect(new URL(request.url).searchParams.get("ref")).toBe(COMMIT);
            return new HttpResponse(files[filePath]);
          },
        ),
      ),
    );

    const imported = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/import",
      payload: {
        repoUrl: "https://ghe.example.test/acme/plugin/tree/main",
        githubAppConfigId: app.id,
        displayName: "Enterprise plugin",
        clientType: "claude-code",
        approvedCommitSha: COMMIT,
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json()).toMatchObject({
      sourceProvider: "github",
      sourceOrigin: "https://ghe.example.test",
      sourceRepo: "acme/plugin",
      sourceRef: "main",
      githubAppConfigId: app.id,
      files: expect.arrayContaining([
        expect.objectContaining({ path: "scripts/run.sh", mode: "100755" }),
      ]),
    });
    expect(authorizations.length).toBeGreaterThan(0);
    expect(
      authorizations.every(
        (value) => value?.toLowerCase() === "bearer ghs_enterprise",
      ),
    ).toBe(true);
  });

  test("discovers a GitLab marketplace with relative, same-host, and foreign entries", async () => {
    const gitlab = fakeGitlab({
      webUrl: "https://gitlab.com",
      projects: {
        "acme/marketplace": {
          ".claude-plugin/marketplace.json": JSON.stringify({
            plugins: [
              { name: "local", source: "./plugins/local" },
              {
                name: "same-host",
                source: "https://gitlab.com/acme/other/-/tree/v1/plugin",
              },
              {
                name: "foreign-url",
                source: "https://example.com/acme/other/plugin",
              },
            ],
          }),
          "plugins/local/hooks/hooks.json": "{}\n",
          "plugins/local/agents/a.md": "A\n",
        },
        "acme/other": { "plugin/agents/b.md": "B\n" },
      },
    });
    server.use(...gitlab.handlers);

    const discovered = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/marketplace/discover",
      payload: { provider: "gitlab", repoUrl: "gitlab.com/acme/marketplace" },
    });
    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(discovered.json()).toMatchObject({
      repoUrl: "acme/marketplace",
      commitSha: COMMIT,
      marketplacePath: ".claude-plugin/marketplace.json",
      reason: null,
    });
    expect(discovered.json().entries).toEqual([
      expect.objectContaining({
        name: "local",
        sourceRepoUrl: "acme/marketplace",
        sourceSubdir: "plugins/local",
        sourceCommitSha: COMMIT,
        fileCount: 2,
        supported: true,
      }),
      expect.objectContaining({
        name: "same-host",
        sourceRepoUrl: "acme/other",
        sourceRef: "v1",
        sourceSubdir: "plugin",
        sourceCommitSha: COMMIT,
        fileCount: 1,
        supported: true,
      }),
      expect.objectContaining({
        name: "foreign-url",
        supported: false,
        reason: expect.stringContaining("not on https://gitlab.com"),
      }),
    ]);
  });

  test("discovers and imports plugin folders from a repository without a marketplace", async () => {
    const gitlab = fakeGitlab({
      webUrl: "https://gitlab.com",
      projects: {
        "acme/agent-plugins": {
          "README.md": "Plugins for our agents\n",
          "plugins/atlassian/plugin.json": JSON.stringify({
            name: "atlassian-tools",
            description: "Jira and Confluence",
            version: "1.2.0",
          }),
          "plugins/atlassian/plugin.yaml": "name: atlassian-tools\n",
          "plugins/atlassian/mcp.json": '{ "servers": {} }\n',
          "plugins/atlassian/skills/jira/SKILL.md": "# Jira\n",
          "plugins/slack/.claude-plugin/plugin.json": "{}",
          "plugins/slack/agents/notifier.md": "Notify.\n",
        },
      },
    });
    server.use(...gitlab.handlers);
    const repository = {
      provider: "gitlab",
      repoUrl: "https://gitlab.com/acme/agent-plugins",
    };

    const discovered = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/marketplace/discover",
      payload: repository,
    });
    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(discovered.json()).toMatchObject({
      repoUrl: "acme/agent-plugins",
      ref: null,
      commitSha: COMMIT,
      marketplacePath: null,
      reason: null,
    });
    const entries = discovered.json().entries;
    expect(entries).toEqual([
      expect.objectContaining({
        marketplacePath: "plugins/atlassian/plugin.json",
        name: "atlassian-tools",
        description: "Jira and Confluence",
        version: "1.2.0",
        clientType: "claude-code",
        sourceRepoUrl: "acme/agent-plugins",
        sourceSubdir: "plugins/atlassian",
        sourceCommitSha: COMMIT,
        fileCount: 4,
        supported: true,
      }),
      expect.objectContaining({
        marketplacePath: "plugins/slack/.claude-plugin/plugin.json",
        name: "slack",
        sourceSubdir: "plugins/slack",
        fileCount: 2,
        supported: true,
      }),
    ]);

    const imported = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/marketplace/import",
      payload: {
        ...repository,
        marketplacePath: null,
        approvedCommitSha: COMMIT,
        trackingRef: null,
        syncInterval: null,
        selected: entries.map(
          (entry: {
            name: string;
            sourceRepoUrl: string;
            sourceRef: string | null;
            sourceSubdir: string;
            sourceCommitSha: string;
          }) => ({
            name: entry.name,
            displayName: entry.name,
            clientType: "claude-code",
            supportedPlatforms: ["posix"],
            sourceRepoUrl: entry.sourceRepoUrl,
            sourceRef: entry.sourceRef,
            sourceSubdir: entry.sourceSubdir,
            approvedSourceSha: entry.sourceCommitSha,
          }),
        ),
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json().failed).toEqual([]);
    const created = imported.json().created;
    expect(created).toEqual([
      expect.objectContaining({
        displayName: "atlassian-tools",
        sourceProvider: "gitlab",
        sourceRepo: "acme/agent-plugins",
        sourceSubdir: "plugins/atlassian",
        sourceMarketplaceRepo: "acme/agent-plugins",
        sourceMarketplacePath: "plugins/atlassian/plugin.json",
        sourceMarketplacePluginName: "atlassian-tools",
      }),
      expect.objectContaining({
        displayName: "slack",
        sourceSubdir: "plugins/slack",
        sourceMarketplacePath: "plugins/slack/.claude-plugin/plugin.json",
      }),
    ]);
    expect(
      created[0].files.map((file: { path: string }) => file.path).sort(),
    ).toEqual([
      "mcp.json",
      "plugin.json",
      "plugin.yaml",
      "skills/jira/SKILL.md",
    ]);
  });

  test("reads a github.com source advertised by a self-managed GitLab marketplace without its token", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const gitlab = fakeGitlab({
      webUrl: "https://gitlab.example.test",
      token: "glpat-marketplace",
      projects: {
        "platform/marketplace": {
          ".claude-plugin/marketplace.json": JSON.stringify({
            plugins: [
              {
                name: "external",
                source: { source: "github", repo: "ext/plugin", ref: "main" },
              },
            ],
          }),
        },
      },
    });
    const githubAuthorizations: (string | null)[] = [];
    const record = (request: Request) => {
      githubAuthorizations.push(request.headers.get("authorization"));
    };
    server.use(
      ...gitlab.handlers,
      http.get(
        "https://api.github.com/repos/ext/plugin/commits/:ref",
        ({ request }) => {
          record(request);
          return HttpResponse.json({ sha: NEXT_COMMIT });
        },
      ),
      http.get(
        "https://api.github.com/repos/ext/plugin/git/trees/:sha",
        ({ request }) => {
          record(request);
          return HttpResponse.json({
            sha: NEXT_COMMIT,
            tree: [
              {
                path: "agents/x.md",
                type: "blob",
                mode: "100644",
                size: 2,
              },
            ],
          });
        },
      ),
      http.get(
        `https://raw.githubusercontent.com/ext/plugin/${NEXT_COMMIT}/agents/x.md`,
        ({ request }) => {
          record(request);
          return new HttpResponse("X\n");
        },
      ),
    );
    const token = await createGitlabToken({
      organizationId: ctx.organizationId,
      data: {
        name: "Marketplace token",
        gitlabUrl: "https://gitlab.example.test",
        token: "glpat-marketplace",
      },
    });
    const repository = {
      repoUrl: "https://gitlab.example.test/platform/marketplace",
      gitlabTokenId: token.id,
    };

    const discovered = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/marketplace/discover",
      payload: repository,
    });
    expect(discovered.statusCode, discovered.body).toBe(200);
    const [entry] = discovered.json().entries;
    expect(entry).toMatchObject({
      name: "external",
      sourceRepoUrl: "https://github.com/ext/plugin",
      sourceRef: "main",
      sourceCommitSha: NEXT_COMMIT,
      fileCount: 1,
      supported: true,
    });

    const imported = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/marketplace/import",
      payload: {
        ...repository,
        marketplacePath: ".claude-plugin/marketplace.json",
        approvedCommitSha: COMMIT,
        trackingRef: null,
        selected: [
          {
            name: entry.name,
            displayName: "External",
            clientType: "claude-code",
            supportedPlatforms: ["posix"],
            sourceRepoUrl: entry.sourceRepoUrl,
            sourceRef: entry.sourceRef,
            sourceSubdir: entry.sourceSubdir,
            approvedSourceSha: entry.sourceCommitSha,
          },
        ],
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json().failed).toEqual([]);
    expect(imported.json().created).toEqual([
      expect.objectContaining({
        sourceProvider: "github",
        sourceOrigin: null,
        sourceRepo: "ext/plugin",
        sourceMarketplaceRepo: "platform/marketplace",
        gitlabTokenId: null,
        githubAppConfigId: null,
      }),
    ]);
    expect(githubAuthorizations.length).toBeGreaterThan(0);
    expect(githubAuthorizations.every((value) => value === null)).toBe(true);
    expect(
      gitlab.requests.every((request) => request.token === "glpat-marketplace"),
    ).toBe(true);
  });

  test("refuses a self-hosted host without a credential before any request", async () => {
    const requests: string[] = [];
    server.events.on("request:start", ({ request }) => {
      requests.push(request.url);
    });

    for (const url of [
      "/api/plugins/github/preview",
      "/api/plugins/github/marketplace/discover",
    ]) {
      const response = await ctx.app.inject({
        method: "POST",
        url,
        payload: {
          provider: "gitlab",
          repoUrl: "https://gitlab.example.test/platform/plugins",
        },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.message).toContain(
        "must belong to https://gitlab.com",
      );
    }

    // A stored self-hosted source whose credential is gone fails its check
    // instead of reaching the host anonymously.
    const plugin = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      input: {
        displayName: "Orphaned source",
        clientType: "claude-code",
        description: "",
        files: [
          { path: "a.md", content: "a", encoding: "utf8", mode: "100644" },
        ],
      },
      source: {
        repo: "platform/plugins",
        ref: null,
        sha: COMMIT,
        subdir: "",
        exclude: [],
        syncInterval: "1h",
        sourceProvider: "gitlab",
        sourceOrigin: "https://gitlab.example.test",
      },
    });
    if (!plugin) throw new Error("failed to seed plugin");
    await handlePluginGithubSync({ pluginId: plugin.id });
    expect(
      await PluginModel.findById({
        id: plugin.id,
        organizationId: ctx.organizationId,
      }),
    ).toMatchObject({
      pendingSourceSha: null,
      lastSyncError: expect.stringContaining("needs a saved credential"),
    });
    expect(requests).toEqual([]);
  });
});

/**
 * A GitLab REST API serving fixed repositories at one commit. Records each
 * request with the token it carried.
 */
function fakeGitlab(params: {
  webUrl: string;
  token?: string;
  projects: Record<string, Record<string, string>>;
  modes?: Record<string, string>;
}) {
  let commit = COMMIT;
  const requests: { url: string; token: string | null }[] = [];
  const respond = ({ request }: { request: Request }) => {
    const token = request.headers.get("private-token");
    requests.push({ url: request.url, token });
    if (params.token && token !== params.token) {
      return HttpResponse.json(
        { message: "401 Unauthorized" },
        { status: 401 },
      );
    }
    const url = new URL(request.url);
    const path = url.pathname.slice("/api/v4/".length);
    if (path === "personal_access_tokens/self") {
      return HttpResponse.json({ scopes: ["read_api"], active: true });
    }
    for (const [project, files] of Object.entries(params.projects)) {
      const base = `projects/${encodeURIComponent(project)}`;
      if (path === base) return HttpResponse.json({ default_branch: "main" });
      if (!path.startsWith(`${base}/repository/`)) continue;
      const rest = path.slice(`${base}/repository/`.length);
      if (rest.startsWith("commits/")) return HttpResponse.json({ id: commit });
      if (rest === "tree") {
        expect(url.searchParams.get("ref")).toBe(commit);
        return HttpResponse.json(
          Object.keys(files).map((filePath) => ({
            path: filePath,
            type: "blob",
            mode: params.modes?.[filePath] ?? "100644",
          })),
        );
      }
      const file = rest.match(/^files\/([^/]+)(\/raw)?$/);
      if (file) {
        const content = files[decodeURIComponent(file[1])];
        if (content === undefined)
          return new HttpResponse(null, { status: 404 });
        return file[2]
          ? new HttpResponse(content)
          : new HttpResponse(null, {
              headers: { "x-gitlab-size": String(Buffer.byteLength(content)) },
            });
      }
    }
    return HttpResponse.json({ message: "404 Not Found" }, { status: 404 });
  };
  const api = `${params.webUrl}/api/v4`;
  const handlers = [
    `${api}/personal_access_tokens/self`,
    `${api}/projects/:project`,
    `${api}/projects/:project/repository/commits/:ref`,
    `${api}/projects/:project/repository/tree`,
    `${api}/projects/:project/repository/files/:file`,
    `${api}/projects/:project/repository/files/:file/raw`,
  ].map((path) => http.all(path, respond));
  return {
    handlers,
    requests,
    setCommit: (next: string) => {
      commit = next;
    },
  };
}
