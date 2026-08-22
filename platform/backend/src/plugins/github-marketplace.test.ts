import { afterEach, describe, expect, test, vi } from "vitest";
import { STUB_COMMIT_SHA, stubGithub } from "@/test/github-skills-stub";
import { discoverGithubMarketplace } from "./github-marketplace";

const gitFallback = vi.hoisted(() => ({
  readPublicGithubTree: vi.fn(),
  resolvePublicGithubCommit: vi.fn(),
}));

vi.mock("./github-public-git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-public-git")>();
  return {
    ...actual,
    readPublicGithubTree: gitFallback.readPublicGithubTree,
    resolvePublicGithubCommit: gitFallback.resolvePublicGithubCommit,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  gitFallback.readPublicGithubTree.mockReset();
  gitFallback.resolvePublicGithubCommit.mockReset();
});

describe("discoverGithubMarketplace", () => {
  test("normalizes multiple local plugins against one immutable repository snapshot", async () => {
    stubGithub([
      {
        owner: "marketplace-owner",
        repo: "local-plugins",
        files: {
          ".claude-plugin/marketplace.json": JSON.stringify({
            plugins: [
              {
                name: "first-plugin",
                description: "First local plugin",
                version: "1.2.3",
                source: "./plugins/first-plugin",
              },
              {
                name: "second-plugin",
                description: "Second local plugin",
                version: "2.0.0",
                source: { source: "local", path: "plugins/second-plugin" },
              },
            ],
          }),
          "plugins/first-plugin/hooks/hooks.json": "{}",
          "plugins/first-plugin/scripts/run.sh": "#!/bin/sh\ntrue\n",
          "plugins/second-plugin/hooks/hooks.json": "{}",
        },
      },
    ]);

    const discovered = await discoverGithubMarketplace({
      repoUrl: "marketplace-owner/local-plugins",
      ref: "release/2026",
    });

    expect(discovered).toMatchObject({
      repoUrl: "marketplace-owner/local-plugins",
      ref: "release/2026",
      commitSha: STUB_COMMIT_SHA,
      marketplacePath: ".claude-plugin/marketplace.json",
      reason: null,
    });
    expect(discovered.entries).toEqual([
      {
        marketplacePath: ".claude-plugin/marketplace.json",
        name: "first-plugin",
        description: "First local plugin",
        version: "1.2.3",
        clientType: "claude-code",
        sourceRepoUrl: "marketplace-owner/local-plugins",
        sourceRef: "release/2026",
        sourceSubdir: "plugins/first-plugin",
        sourceCommitSha: STUB_COMMIT_SHA,
        fileCount: 2,
        supported: true,
        reason: null,
      },
      {
        marketplacePath: ".claude-plugin/marketplace.json",
        name: "second-plugin",
        description: "Second local plugin",
        version: "2.0.0",
        clientType: "claude-code",
        sourceRepoUrl: "marketplace-owner/local-plugins",
        sourceRef: "release/2026",
        sourceSubdir: "plugins/second-plugin",
        sourceCommitSha: STUB_COMMIT_SHA,
        fileCount: 1,
        supported: true,
        reason: null,
      },
    ]);
  });

  test("supports official-style Claude plugins without hooks", async () => {
    stubGithub([
      {
        owner: "marketplace-owner",
        repo: "component-plugins",
        files: {
          ".claude-plugin/marketplace.json": JSON.stringify({
            plugins: [
              {
                name: "agent-toolkit",
                description: "Agent and MCP components",
                source: "./plugins/agent-toolkit",
              },
            ],
          }),
          "plugins/agent-toolkit/.claude-plugin/plugin.json": JSON.stringify({
            name: "agent-toolkit",
          }),
          "plugins/agent-toolkit/.mcp.json": JSON.stringify({
            mcpServers: {},
          }),
          "plugins/agent-toolkit/agents/reviewer.md": "Review changes.",
        },
      },
    ]);

    const discovered = await discoverGithubMarketplace({
      repoUrl: "marketplace-owner/component-plugins",
    });

    expect(discovered.entries).toEqual([
      expect.objectContaining({
        name: "agent-toolkit",
        fileCount: 3,
        supported: true,
        reason: null,
      }),
    ]);
  });

  test("defers tree inspection for pinned external sources beyond the preview budget", async () => {
    const externalPlugins = Array.from({ length: 26 }, (_, index) => ({
      name: `external-${index}`,
      source: {
        source: "git-subdir",
        url: `https://github.com/external-owner/plugin-${index}.git`,
        path: "plugin",
        ref: "main",
        sha: STUB_COMMIT_SHA,
      },
    }));
    stubGithub([
      {
        owner: "marketplace-owner",
        repo: "large-external-catalog",
        files: {
          ".claude-plugin/marketplace.json": JSON.stringify({
            plugins: externalPlugins,
          }),
        },
      },
      ...externalPlugins.slice(0, 25).map((_, index) => ({
        owner: "external-owner",
        repo: `plugin-${index}`,
        files: { "plugin/agents/reviewer.md": "Review changes.\n" },
      })),
    ]);

    const discovered = await discoverGithubMarketplace({
      repoUrl: "marketplace-owner/large-external-catalog",
    });

    expect(discovered.entries).toHaveLength(26);
    expect(discovered.entries.slice(0, 25)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ supported: true, fileCount: 1 }),
      ]),
    );
    expect(discovered.entries[25]).toMatchObject({
      name: "external-25",
      sourceRepoUrl: "external-owner/plugin-25",
      sourceRef: "main",
      sourceSubdir: "plugin",
      sourceCommitSha: STUB_COMMIT_SHA,
      fileCount: 0,
      supported: true,
      reason: null,
    });
  });

  test("resolves external GitHub source objects and URLs with their tracking refs", async () => {
    stubGithub([
      {
        owner: "marketplace-owner",
        repo: "external-plugin",
        files: {
          ".cursor-plugin/marketplace.json": JSON.stringify({
            plugins: [
              {
                name: "remote-plugin",
                description: "External plugin",
                version: "3.4.5",
                source: {
                  source: "github",
                  repo: "plugin-owner/plugin-repo",
                  ref: "stable/v3",
                  path: "integrations/cursor",
                },
              },
              {
                name: "url-plugin",
                source:
                  "https://github.com/url-owner/url-repo/tree/release-v2/plugins/cursor",
              },
            ],
          }),
        },
      },
      {
        owner: "plugin-owner",
        repo: "plugin-repo",
        files: {
          "integrations/cursor/hooks/hooks.json": "{}",
          "integrations/cursor/scripts/run.sh": "#!/bin/sh\ntrue\n",
        },
      },
      {
        owner: "url-owner",
        repo: "url-repo",
        files: { "plugins/cursor/hooks/hooks.json": "{}" },
      },
    ]);

    const discovered = await discoverGithubMarketplace({
      repoUrl: "marketplace-owner/external-plugin",
      ref: "marketplace-release",
    });

    expect(discovered.entries).toEqual([
      {
        marketplacePath: ".cursor-plugin/marketplace.json",
        name: "remote-plugin",
        description: "External plugin",
        version: "3.4.5",
        clientType: "cursor",
        sourceRepoUrl: "plugin-owner/plugin-repo",
        sourceRef: "stable/v3",
        sourceSubdir: "integrations/cursor",
        sourceCommitSha: STUB_COMMIT_SHA,
        fileCount: 2,
        supported: true,
        reason: null,
      },
      {
        marketplacePath: ".cursor-plugin/marketplace.json",
        name: "url-plugin",
        description: "",
        version: "",
        clientType: "cursor",
        sourceRepoUrl: "url-owner/url-repo",
        sourceRef: "release-v2",
        sourceSubdir: "plugins/cursor",
        sourceCommitSha: STUB_COMMIT_SHA,
        fileCount: 1,
        supported: true,
        reason: null,
      },
    ]);
  });

  test("returns malformed and unsafe plugin entries as unsupported metadata", async () => {
    stubGithub([
      {
        owner: "marketplace-owner",
        repo: "unsupported",
        files: {
          "marketplace.json": JSON.stringify({
            clientType: "codex",
            plugins: [null, { name: "unsafe-plugin", source: "../outside" }],
          }),
        },
      },
    ]);

    const discovered = await discoverGithubMarketplace({
      repoUrl: "marketplace-owner/unsupported",
    });

    expect(discovered.entries).toEqual([
      expect.objectContaining({
        marketplacePath: "marketplace.json",
        name: "",
        clientType: "codex",
        supported: false,
        reason: "Plugin entry must be an object",
      }),
      expect.objectContaining({
        marketplacePath: "marketplace.json",
        name: "unsafe-plugin",
        sourceSubdir: "",
        supported: false,
        reason: "Plugin source must be a safe relative path or GitHub URL",
      }),
    ]);
  });

  test("marks duplicate marketplace names unsupported", async () => {
    stubGithub([
      {
        owner: "marketplace-owner",
        repo: "duplicates",
        files: {
          ".claude-plugin/marketplace.json": JSON.stringify({
            plugins: [
              { name: "same-name", source: "./plugins/one" },
              { name: "same-name", source: "./plugins/two" },
            ],
          }),
        },
      },
    ]);

    const discovered = await discoverGithubMarketplace({
      repoUrl: "marketplace-owner/duplicates",
    });
    expect(discovered.entries).toHaveLength(2);
    expect(discovered.entries.every((entry) => !entry.supported)).toBe(true);
    expect(discovered.entries[0]?.reason).toContain("duplicate plugin name");
  });

  test("rejects manifests beyond the bounded discovery budget", async () => {
    stubGithub([
      {
        owner: "oversized-owner",
        repo: "oversized-marketplace",
        files: {
          ".claude-plugin/marketplace.json": JSON.stringify({
            plugins: Array.from({ length: 501 }, (_, index) => ({
              name: `plugin-${index}`,
              source: `./plugins/plugin-${index}`,
            })),
          }),
        },
      },
    ]);

    await expect(
      discoverGithubMarketplace({
        repoUrl: "oversized-owner/oversized-marketplace",
      }),
    ).rejects.toThrow("the discovery limit is 500");
  });

  test("uses the documented manifest priority and accepts an explicit supported path", async () => {
    stubGithub([
      {
        owner: "marketplace-owner",
        repo: "priority",
        files: {
          ".claude-plugin/marketplace.json": JSON.stringify({
            plugins: [{ name: "claude-plugin", source: "./plugins/claude" }],
          }),
          "marketplace.json": JSON.stringify({
            clientType: "codex",
            plugins: [{ name: "root-plugin", source: "./plugins/root" }],
          }),
        },
      },
    ]);

    const detected = await discoverGithubMarketplace({
      repoUrl: "marketplace-owner/priority",
    });
    const explicit = await discoverGithubMarketplace({
      repoUrl: "marketplace-owner/priority",
      marketplacePath: "marketplace.json",
    });

    expect(detected.marketplacePath).toBe(".claude-plugin/marketplace.json");
    expect(detected.entries[0]?.name).toBe("claude-plugin");
    expect(explicit.marketplacePath).toBe("marketplace.json");
    expect(explicit.entries[0]?.name).toBe("root-plugin");
  });

  test("forwards the supplied token to GitHub metadata and raw manifest requests", async () => {
    const fetchMock = stubGithub([
      {
        owner: "private-owner",
        repo: "private-marketplace",
        files: {
          "marketplace.json": JSON.stringify({
            clientType: "codex",
            plugins: [{ name: "private-plugin", source: "./plugins/private" }],
          }),
        },
      },
    ]);

    await discoverGithubMarketplace({
      repoUrl: "private-owner/private-marketplace",
      githubToken: "private-token",
    });

    const authorizationHeaders = fetchMock.mock.calls.map(([input, init]) => {
      const request =
        input instanceof Request ? input : new Request(input as string, init);
      return request.headers.get("authorization");
    });
    expect(authorizationHeaders).toContain("token private-token");
    expect(authorizationHeaders).toContain("Bearer private-token");
  });

  test("falls back to public Git when the anonymous REST quota is exhausted", async () => {
    const fetchMock = stubGithub([
      {
        owner: "rate-limited-owner",
        repo: "public-marketplace",
        files: {
          ".claude-plugin/marketplace.json": JSON.stringify({
            plugins: [
              {
                name: "public-plugin",
                source: "./plugins/public-plugin",
              },
            ],
          }),
        },
      },
    ]);
    const githubStub = fetchMock.getMockImplementation() as
      | ((input: string | URL | Request) => Promise<Response>)
      | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      if (url.hostname === "api.github.com") {
        return Response.json(
          { message: "API rate limit exceeded for shared egress" },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          },
        );
      }
      if (
        url.hostname === "raw.githubusercontent.com" &&
        (init?.method === "HEAD" ||
          (input instanceof Request && input.method === "HEAD"))
      ) {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "100" },
        });
      }
      if (!githubStub) throw new Error("GitHub stub is not configured");
      return githubStub(input);
    });
    gitFallback.resolvePublicGithubCommit.mockResolvedValue(STUB_COMMIT_SHA);
    gitFallback.readPublicGithubTree.mockResolvedValue([
      {
        type: "blob",
        path: "plugins/public-plugin/hooks/hooks.json",
        mode: "100644",
      },
    ]);

    const discovered = await discoverGithubMarketplace({
      repoUrl: "rate-limited-owner/public-marketplace",
    });

    expect(discovered).toMatchObject({
      commitSha: STUB_COMMIT_SHA,
      marketplacePath: ".claude-plugin/marketplace.json",
      reason: null,
    });
    expect(discovered.entries[0]).toMatchObject({
      name: "public-plugin",
      sourceCommitSha: STUB_COMMIT_SHA,
      fileCount: 1,
      supported: true,
    });
    expect(gitFallback.resolvePublicGithubCommit).toHaveBeenCalledOnce();
  });
});
