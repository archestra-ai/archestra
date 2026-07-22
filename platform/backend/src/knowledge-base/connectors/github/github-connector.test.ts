import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types";
import { GithubConnector } from "./github-connector";

// Mock @octokit/rest SDK
const mockGetAuthenticated = vi.fn();
const mockListReposAccessibleToInstallation = vi.fn();
const mockListForRepo = vi.fn();
const mockListForOrg = vi.fn();
const mockListComments = vi.fn();
const mockGetRef = vi.fn();
const mockGetTree = vi.fn();
const mockGetContent = vi.fn();
const mockReposGet = vi.fn();
const mockListCollaborators = vi.fn();
const mockReposListTeams = vi.fn();
const mockTeamsList = vi.fn();
const mockListMembersInOrg = vi.fn();
const mockGetByUsername = vi.fn();
const capturedOctokitOptions: Record<string, unknown>[] = [];

vi.mock("@/cache-manager");

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    constructor(options: Record<string, unknown>) {
      capturedOctokitOptions.push(options);
    }

    rest = {
      users: {
        getAuthenticated: mockGetAuthenticated,
        getByUsername: mockGetByUsername,
      },
      apps: {
        listReposAccessibleToInstallation:
          mockListReposAccessibleToInstallation,
      },
      repos: {
        listForOrg: mockListForOrg,
        getContent: mockGetContent,
        get: mockReposGet,
        listCollaborators: mockListCollaborators,
        listTeams: mockReposListTeams,
      },
      issues: {
        listForRepo: mockListForRepo,
        listComments: mockListComments,
      },
      teams: {
        list: mockTeamsList,
        listMembersInOrg: mockListMembersInOrg,
      },
      git: { getRef: mockGetRef, getTree: mockGetTree },
    };
  },
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createPrivateKey: vi.fn(() => "mock-key"),
  };
});

vi.mock("jose", () => ({
  SignJWT: class MockSignJWT {
    setProtectedHeader() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    setIssuer() {
      return this;
    }
    async sign() {
      return "app-jwt";
    }
  },
}));

describe("GithubConnector", () => {
  let connector: GithubConnector;

  const validConfig = {
    githubUrl: "https://api.github.com",
    owner: "test-org",
    repos: ["my-repo"],
  };

  const credentials = {
    apiToken: "ghp_test-token-123",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOctokitOptions.length = 0;
    connector = new GithubConnector();
    // Default: repos.get returns main as default branch
    mockReposGet.mockResolvedValue({
      data: { default_branch: "main" },
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("validateConfig", () => {
    test("returns valid for correct config", async () => {
      const result = await connector.validateConfig(validConfig);
      expect(result).toEqual({ valid: true });
    });

    test("returns invalid when githubUrl is missing", async () => {
      const result = await connector.validateConfig({ owner: "test-org" });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("githubUrl");
    });

    test("returns invalid when owner is missing", async () => {
      const result = await connector.validateConfig({
        githubUrl: "https://api.github.com",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("owner");
    });

    test("returns invalid when githubUrl uses unsupported protocol", async () => {
      const result = await connector.validateConfig({
        githubUrl: "ftp://github.example.com",
        owner: "test-org",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("valid HTTP(S) URL");
    });

    test("accepts URL without protocol by prepending https://", async () => {
      const result = await connector.validateConfig({
        githubUrl: "api.github.com",
        owner: "test-org",
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts config with optional repos filter", async () => {
      const result = await connector.validateConfig({
        githubUrl: "https://api.github.com",
        owner: "test-org",
        repos: ["repo-a", "repo-b"],
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts config with boolean flags", async () => {
      const result = await connector.validateConfig({
        githubUrl: "https://api.github.com",
        owner: "test-org",
        includeIssues: true,
        includePullRequests: false,
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts GitHub Enterprise Server URL", async () => {
      const result = await connector.validateConfig({
        githubUrl: "https://github.mycompany.com/api/v3",
        owner: "engineering",
      });
      expect(result).toEqual({ valid: true });
    });

    test("requires a config reference when GitHub App auth is selected", async () => {
      const result = await connector.validateConfig({
        githubUrl: "https://api.github.com",
        owner: "test-org",
        authMethod: "github_app",
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("githubAppConfigId");
    });
  });

  describe("testConnection", () => {
    test("returns success when API responds OK", async () => {
      mockGetAuthenticated.mockResolvedValueOnce({
        data: { login: "test-user" },
      });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockGetAuthenticated).toHaveBeenCalled();
    });

    test("returns error when API throws", async () => {
      mockGetAuthenticated.mockRejectedValueOnce(
        new Error("401 Bad credentials"),
      );

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    test("returns error for invalid config", async () => {
      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid GitHub configuration");
    });

    test("uses GitHub App installation token when app auth is configured", async () => {
      mockListReposAccessibleToInstallation.mockResolvedValueOnce({
        data: { repositories: [] },
      });
      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: "installation-token" }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      try {
        const result = await connector.testConnection({
          config: {
            ...validConfig,
            authMethod: "github_app",
            githubAppConfigId: "00000000-0000-4000-8000-000000000001",
          },
          credentials: {
            apiToken: [
              "-----BEGIN PRIVATE KEY-----",
              "MIIB",
              "-----END PRIVATE KEY-----",
            ].join("\\n"),
            githubApp: {
              githubUrl: "https://api.github.com",
              appId: "12345",
              installationId: "67890",
            },
          },
        });

        expect(result).toEqual({ success: true });
        expect(mockFetch).toHaveBeenCalledWith(
          "https://api.github.com/app/installations/67890/access_tokens",
          expect.objectContaining({ method: "POST" }),
        );
        expect(mockListReposAccessibleToInstallation).toHaveBeenCalledWith({
          per_page: 1,
        });
        expect(mockGetAuthenticated).not.toHaveBeenCalled();
        expect(capturedOctokitOptions[0]?.auth).toBe("installation-token");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("includes GitHub App installation token error response message", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => JSON.stringify({ message: "Bad credentials" }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      try {
        const result = await connector.testConnection({
          config: {
            ...validConfig,
            authMethod: "github_app",
            githubAppConfigId: "00000000-0000-4000-8000-000000000002",
          },
          credentials: {
            apiToken: [
              "-----BEGIN PRIVATE KEY-----",
              "MIIB",
              "-----END PRIVATE KEY-----",
            ].join("\\n"),
            githubApp: {
              githubUrl: "https://api.github.com",
              appId: "12345",
              installationId: "67892",
            },
          },
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Bad credentials");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("reuses cached GitHub App installation tokens", async () => {
      mockListReposAccessibleToInstallation
        .mockResolvedValueOnce({ data: { repositories: [] } })
        .mockResolvedValueOnce({ data: { repositories: [] } });
      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: "cached-installation-token" }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const config = {
        ...validConfig,
        authMethod: "github_app",
        githubAppConfigId: "00000000-0000-4000-8000-000000000003",
      };
      const appCredentials = {
        apiToken: [
          "-----BEGIN PRIVATE KEY-----",
          "MIIB",
          "-----END PRIVATE KEY-----",
        ].join("\\n"),
        githubApp: {
          githubUrl: "https://api.github.com",
          appId: "12345",
          installationId: "67891",
        },
      };

      try {
        await connector.testConnection({ config, credentials: appCredentials });
        await connector.testConnection({ config, credentials: appCredentials });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(capturedOctokitOptions[0]?.auth).toBe(
          "cached-installation-token",
        );
        expect(capturedOctokitOptions[1]?.auth).toBe(
          "cached-installation-token",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("sync", () => {
    function makeIssue(
      number: number,
      title: string,
      opts?: { isPr?: boolean; labels?: string[]; body?: string },
    ) {
      return {
        number,
        title,
        body: opts?.body ?? `Description for ${title}`,
        state: "open",
        html_url: `https://github.com/test-org/my-repo/issues/${number}`,
        user: { login: "author" },
        labels: (opts?.labels ?? []).map((name) => ({ name })),
        updated_at: "2024-01-15T10:00:00.000Z",
        pull_request: opts?.isPr
          ? {
              url: `https://api.github.com/repos/test-org/my-repo/pulls/${number}`,
            }
          : undefined,
      };
    }

    test("yields batch of documents from issues", async () => {
      const issues = [
        makeIssue(1, "First issue"),
        makeIssue(2, "Second issue"),
      ];

      // Issues pass
      mockListForRepo.mockResolvedValueOnce({ data: issues });
      mockListComments
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] });

      // PR pass
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      // First batch: issues (not last group because PRs still to come)
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("my-repo#1");
      expect(batches[0].documents[0].title).toContain("First issue");
      expect(batches[0].documents[1].id).toBe("my-repo#2");
    });

    test("resolves fully-qualified owner/repo slugs against their own owner, not config.owner", async () => {
      // Regression: repo entries pasted as `owner/repo` slugs (the only way to
      // span multiple owners) were paired with config.owner, producing
      // `/repos/{config.owner}/{owner/repo}` — a 404 the sync silently swallowed
      // as "repo not found", ingesting zero documents.
      mockListForRepo.mockResolvedValue({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          githubUrl: "https://api.github.com",
          owner: "config-owner",
          repos: ["other-org/their-repo"],
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Metadata lookup and issue/PR fetches all target the slug's own owner.
      expect(mockReposGet).toHaveBeenCalledWith({
        owner: "other-org",
        repo: "their-repo",
      });
      expect(mockListForRepo).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "other-org", repo: "their-repo" }),
      );
      expect(mockListForRepo).not.toHaveBeenCalledWith(
        expect.objectContaining({ owner: "config-owner" }),
      );
    });

    test("treats a bare repo name as belonging to config.owner", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      for await (const _batch of connector.sync({
        config: {
          githubUrl: "https://api.github.com",
          owner: "config-owner",
          repos: ["bare-repo"],
        },
        credentials,
        checkpoint: null,
      })) {
        // drain
      }

      expect(mockListForRepo).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "config-owner", repo: "bare-repo" }),
      );
    });

    test("discovers repositories from GitHub App installation when repos are omitted", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: "installation-token" }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      mockListReposAccessibleToInstallation.mockResolvedValueOnce({
        data: {
          repositories: [
            {
              name: "app-repo",
              html_url: "https://github.com/test-org/app-repo",
              default_branch: "main",
              owner: { login: "test-org" },
            },
          ],
        },
      });
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      try {
        const batches: ConnectorSyncBatch[] = [];
        for await (const batch of connector.sync({
          config: {
            githubUrl: "https://api.github.com",
            owner: "test-org",
            authMethod: "github_app",
            githubAppConfigId: "00000000-0000-4000-8000-000000000004",
          },
          credentials: {
            apiToken: [
              "-----BEGIN PRIVATE KEY-----",
              "MIIB",
              "-----END PRIVATE KEY-----",
            ].join("\\n"),
            githubApp: {
              githubUrl: "https://api.github.com",
              appId: "12345",
              installationId: "67893",
            },
          },
          checkpoint: null,
        })) {
          batches.push(batch);
        }

        expect(batches).toHaveLength(2);
        expect(mockListReposAccessibleToInstallation).toHaveBeenCalledWith({
          per_page: 100,
          page: 1,
        });
        expect(mockListForOrg).not.toHaveBeenCalled();
        expect(mockListForRepo).toHaveBeenCalledWith(
          expect.objectContaining({
            owner: "test-org",
            repo: "app-repo",
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("separates issues and pull requests", async () => {
      const mixed = [
        makeIssue(1, "An issue"),
        makeIssue(2, "A PR", { isPr: true }),
      ];

      // Issues pass: returns both, but connector filters out PRs
      mockListForRepo.mockResolvedValueOnce({ data: mixed });
      mockListComments.mockResolvedValueOnce({ data: [] });

      // PRs pass: returns both, but connector filters out non-PRs
      mockListForRepo.mockResolvedValueOnce({ data: mixed });
      mockListComments.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Should have 2 batches: issues and PRs
      const allDocs = batches.flatMap((b) => b.documents);
      const issueDocs = allDocs.filter((d) => d.metadata.kind === "issue");
      const prDocs = allDocs.filter((d) => d.metadata.kind === "pr");

      expect(issueDocs).toHaveLength(1);
      expect(issueDocs[0].title).toContain("An issue");
      expect(prDocs).toHaveLength(1);
      expect(prDocs[0].title).toContain("A PR");
    });

    test("includes comments in document content", async () => {
      mockListForRepo.mockResolvedValueOnce({
        data: [makeIssue(1, "Issue with comments")],
      });
      mockListComments.mockResolvedValueOnce({
        data: [
          {
            user: { login: "reviewer" },
            body: "Looks good to me!",
            created_at: "2024-01-16T12:00:00.000Z",
          },
          {
            user: { login: "author" },
            body: "Thanks for the review",
            created_at: "2024-01-16T13:00:00.000Z",
          },
        ],
      });

      // PR pass - empty
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const content = batches[0].documents[0].content;
      expect(content).toContain("## Comments");
      expect(content).toContain("**reviewer**");
      expect(content).toContain("Looks good to me!");
      expect(content).toContain("**author**");
      expect(content).toContain("Thanks for the review");
    });

    test("paginates through multiple pages", async () => {
      const page1Issues = Array.from({ length: 50 }, (_, i) =>
        makeIssue(i + 1, `Issue ${i + 1}`),
      );
      const page2Issues = [makeIssue(51, "Issue 51")];

      mockListForRepo
        .mockResolvedValueOnce({ data: page1Issues })
        .mockResolvedValueOnce({ data: page2Issues });

      // Comments for each issue
      for (let i = 0; i < 51; i++) {
        mockListComments.mockResolvedValueOnce({ data: [] });
      }

      // PR pass - empty
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // First batch: 50 issues (hasMore true), second batch: 1 issue, third: PR pass
      expect(batches[0].documents).toHaveLength(50);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].documents).toHaveLength(1);
    });

    test("incremental sync uses checkpoint timestamp", async () => {
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      // PR pass
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: { lastSyncedAt: "2024-01-10T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      expect(mockListForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          since: "2024-01-10T00:00:00.000Z",
        }),
      );
    });

    test("skips items with labels in labelsToSkip", async () => {
      const issues = [
        makeIssue(1, "Keep this"),
        makeIssue(2, "Skip this", { labels: ["wontfix"] }),
      ];

      mockListForRepo.mockResolvedValueOnce({ data: issues });
      mockListComments.mockResolvedValueOnce({ data: [] });

      // PR pass
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, labelsToSkip: ["wontfix"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      const issueDocs = allDocs.filter((d) => d.metadata.kind === "issue");
      expect(issueDocs).toHaveLength(1);
      expect(issueDocs[0].title).toContain("Keep this");
    });

    test("respects includeIssues=false", async () => {
      // Only PR pass should run
      mockListForRepo.mockResolvedValueOnce({
        data: [makeIssue(1, "A PR", { isPr: true })],
      });
      mockListComments.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeIssues: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Only PR batch
      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs.every((d) => d.metadata.kind === "pr")).toBe(true);
    });

    test("respects includePullRequests=false", async () => {
      mockListForRepo.mockResolvedValueOnce({
        data: [makeIssue(1, "An issue")],
      });
      mockListComments.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includePullRequests: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Only issue batch
      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs.every((d) => d.metadata.kind === "issue")).toBe(true);
      // listForRepo should only be called once (no PR pass)
      expect(mockListForRepo).toHaveBeenCalledTimes(1);
    });

    test("builds source URL correctly", async () => {
      mockListForRepo.mockResolvedValueOnce({
        data: [makeIssue(42, "Test issue")],
      });
      mockListComments.mockResolvedValueOnce({ data: [] });
      // PR pass
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://github.com/test-org/my-repo/issues/42",
      );
    });

    test("includes metadata in documents", async () => {
      mockListForRepo.mockResolvedValueOnce({
        data: [makeIssue(1, "Test issue", { labels: ["bug", "urgent"] })],
      });
      mockListComments.mockResolvedValueOnce({ data: [] });
      // PR pass
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.repo).toBe("test-org/my-repo");
      expect(metadata.number).toBe(1);
      expect(metadata.state).toBe("open");
      expect(metadata.kind).toBe("issue");
      expect(metadata.labels).toEqual(["bug", "urgent"]);
      expect(metadata.author).toBe("author");
    });

    test("continues sync when comment fetch fails for one item", async () => {
      const issues = [
        makeIssue(1, "First issue"),
        makeIssue(2, "Second issue"),
        makeIssue(3, "Third issue"),
      ];

      mockListForRepo.mockResolvedValueOnce({ data: issues });
      mockListComments
        .mockResolvedValueOnce({ data: [] })
        .mockRejectedValueOnce(new Error("502 Bad Gateway"))
        .mockResolvedValueOnce({ data: [] });

      // PR pass
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // All 3 documents should still be yielded
      expect(batches[0].documents).toHaveLength(3);
      expect(batches[0].documents[0].id).toBe("my-repo#1");
      expect(batches[0].documents[1].id).toBe("my-repo#2");
      expect(batches[0].documents[2].id).toBe("my-repo#3");

      // Second doc should have no comments (fallback)
      expect(batches[0].documents[1].content).not.toContain("## Comments");

      // Failures array should contain 1 entry
      expect(batches[0].failures).toHaveLength(1);
      expect(batches[0].failures?.[0]).toEqual({
        itemId: 2,
        resource: "comments",
        error: "502 Bad Gateway",
      });
    });

    test("skips repo when issues endpoint returns 404 (issues disabled)", async () => {
      const configWithTwoRepos = {
        githubUrl: "https://api.github.com",
        owner: "test-org",
        repos: ["no-issues-repo", "normal-repo"],
      };

      const notFoundError = Object.assign(new Error("Not Found"), {
        status: 404,
      });

      // no-issues-repo: issues pass returns 404
      mockListForRepo.mockRejectedValueOnce(notFoundError);
      // no-issues-repo: PR pass also returns 404
      mockListForRepo.mockRejectedValueOnce(notFoundError);

      // normal-repo: issues pass
      mockListForRepo.mockResolvedValueOnce({
        data: [makeIssue(1, "Normal issue")],
      });
      mockListComments.mockResolvedValueOnce({ data: [] });
      // normal-repo: PR pass
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: configWithTwoRepos,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(1);
      expect(allDocs[0].title).toContain("Normal issue");
    });

    test("throws on API error", async () => {
      mockListForRepo.mockRejectedValueOnce(
        new Error("Request failed with status code 403"),
      );

      const generator = connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow();
    });

    test("discovers repos from org when repos not specified", async () => {
      const configWithoutRepos = {
        githubUrl: "https://api.github.com",
        owner: "test-org",
      };

      mockListForOrg.mockResolvedValueOnce({
        data: [
          {
            name: "repo-a",
            html_url: "https://github.com/test-org/repo-a",
            default_branch: "main",
          },
          {
            name: "repo-b",
            html_url: "https://github.com/test-org/repo-b",
            default_branch: "main",
          },
        ],
      });

      // Issues for repo-a
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      // PRs for repo-a
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      // Issues for repo-b
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      // PRs for repo-b
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: configWithoutRepos,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockListForOrg).toHaveBeenCalledWith(
        expect.objectContaining({ org: "test-org" }),
      );
    });

    test("checkpoint uses last item updated_at timestamp instead of current time", async () => {
      const issues = [
        makeIssue(1, "First issue"),
        {
          ...makeIssue(2, "Second issue"),
          updated_at: "2024-06-20T15:30:00.000Z",
        },
      ];

      mockListForRepo.mockResolvedValueOnce({ data: issues });
      mockListComments
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] });
      // PR pass
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const checkpoint = batches[0].checkpoint as {
        type: string;
        lastSyncedAt?: string;
      };
      expect(checkpoint.type).toBe("github");
      expect(checkpoint.lastSyncedAt).toBe("2024-06-20T15:30:00.000Z");
    });

    test("checkpoint preserves previous value when batch has no items", async () => {
      // Issues pass - empty
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      // PR pass - empty
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "github",
          lastSyncedAt: "2024-01-10T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      const checkpoint = batches[0].checkpoint as {
        lastSyncedAt?: string;
      };
      expect(checkpoint.lastSyncedAt).toBe("2024-01-10T00:00:00.000Z");
    });
  });

  describe("repository file sync", () => {
    test("fetches and indexes repository files when includeRepositoryFiles is true", async () => {
      // Issues pass - empty
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      // PR pass - empty
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      // Repository files: resolve default branch
      mockGetRef.mockResolvedValueOnce({
        data: { object: { sha: "abc123" } },
      });

      // Repository files: get tree
      mockGetTree.mockResolvedValueOnce({
        data: {
          tree: [
            { type: "blob", path: "README.md", sha: "sha1" },
            { type: "blob", path: "docs/guide.mdx", sha: "sha2" },
            { type: "blob", path: "infra/deploy.yaml", sha: "sha5" },
            { type: "blob", path: "src/index.ts", sha: "sha3" },
            { type: "tree", path: "docs", sha: "sha4" },
          ],
        },
      });

      // Repository files: get file contents
      mockGetContent
        .mockResolvedValueOnce({
          data: {
            content: Buffer.from("# README\nHello world").toString("base64"),
          },
        })
        .mockResolvedValueOnce({
          data: {
            content: Buffer.from("# Guide\nSome guide content").toString(
              "base64",
            ),
          },
        })
        .mockResolvedValueOnce({
          data: {
            content: Buffer.from("apiVersion: v1").toString("base64"),
          },
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeRepositoryFiles: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const mdDocs = batches
        .flatMap((b) => b.documents)
        .filter((d) => d.metadata.kind === "repository_file");

      expect(mdDocs).toHaveLength(3);
      expect(mdDocs[0].id).toBe("my-repo#file:README.md");
      expect(mdDocs[0].title).toBe("README.md (test-org/my-repo)");
      expect(mdDocs[0].content).toBe("# README\nHello world");
      expect(mdDocs[0].sourceUrl).toContain("blob/main/README.md");
      expect(mdDocs[0].metadata.filePath).toBe("README.md");
      expect(mdDocs[0].metadata.kind).toBe("repository_file");
      expect(mdDocs[0].metadata.fileKind).toBe("repository_file");

      expect(mdDocs[1].id).toBe("my-repo#file:docs/guide.mdx");
      expect(mdDocs[1].content).toBe("# Guide\nSome guide content");

      expect(mdDocs[2].id).toBe("my-repo#file:infra/deploy.yaml");
      expect(mdDocs[2].content).toBe("apiVersion: v1");
    });

    test("uses configured file types for repository file indexing", async () => {
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      mockGetRef.mockResolvedValueOnce({
        data: { object: { sha: "abc123" } },
      });
      mockGetTree.mockResolvedValueOnce({
        data: {
          tree: [
            { type: "blob", path: "src/index.ts", sha: "sha1" },
            { type: "blob", path: "README.md", sha: "sha2" },
          ],
        },
      });
      mockGetContent.mockResolvedValueOnce({
        data: {
          content: Buffer.from("export const value = 1;").toString("base64"),
        },
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          includeRepositoryFiles: true,
          fileTypes: [".ts"],
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const repoDocs = batches
        .flatMap((b) => b.documents)
        .filter((d) => d.metadata.kind === "repository_file");

      expect(repoDocs).toHaveLength(1);
      expect(repoDocs[0].id).toBe("my-repo#file:src/index.ts");
      expect(repoDocs[0].metadata.kind).toBe("repository_file");
      expect(repoDocs[0].metadata.fileKind).toBe("repository_file");
      expect(mockGetContent).toHaveBeenCalledWith(
        expect.objectContaining({ path: "src/index.ts" }),
      );
    });

    test("does not fetch repository files when includeRepositoryFiles is not set", async () => {
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockGetRef).not.toHaveBeenCalled();
      expect(mockGetTree).not.toHaveBeenCalled();
    });

    test("uses known default branch directly without fallback", async () => {
      // repos.get returns "develop" as default branch
      mockReposGet.mockReset();
      mockReposGet.mockResolvedValueOnce({
        data: { default_branch: "develop" },
      });

      mockListForRepo.mockResolvedValueOnce({ data: [] });
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      mockGetRef.mockResolvedValueOnce({
        data: { object: { sha: "dev-sha" } },
      });

      mockGetTree.mockResolvedValueOnce({
        data: {
          tree: [{ type: "blob", path: "README.md", sha: "sha1" }],
        },
      });

      mockGetContent.mockResolvedValueOnce({
        data: {
          content: Buffer.from("# Hello").toString("base64"),
        },
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeRepositoryFiles: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Should only call getRef once with the known default branch
      expect(mockGetRef).toHaveBeenCalledTimes(1);
      expect(mockGetRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "heads/develop" }),
      );

      const mdDocs = batches
        .flatMap((b) => b.documents)
        .filter((d) => d.metadata.kind === "repository_file");
      expect(mdDocs).toHaveLength(1);
      expect(mdDocs[0].sourceUrl).toContain("/blob/develop/README.md");
    });

    test("falls back through main/master/dev/develop when defaultBranch is null", async () => {
      // repos.get fails, so defaultBranch will be null
      mockReposGet.mockReset();
      mockReposGet.mockRejectedValueOnce(new Error("Not found"));

      mockListForRepo.mockResolvedValueOnce({ data: [] });
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      // main, master, dev all fail
      mockGetRef.mockRejectedValueOnce(new Error("Not found"));
      mockGetRef.mockRejectedValueOnce(new Error("Not found"));
      mockGetRef.mockRejectedValueOnce(new Error("Not found"));
      // develop succeeds
      mockGetRef.mockResolvedValueOnce({
        data: { object: { sha: "develop-sha" } },
      });

      mockGetTree.mockResolvedValueOnce({
        data: {
          tree: [{ type: "blob", path: "README.md", sha: "sha1" }],
        },
      });

      mockGetContent.mockResolvedValueOnce({
        data: {
          content: Buffer.from("# Hello").toString("base64"),
        },
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeRepositoryFiles: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockGetRef).toHaveBeenCalledTimes(4);
      expect(mockGetRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "heads/main" }),
      );
      expect(mockGetRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "heads/master" }),
      );
      expect(mockGetRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "heads/dev" }),
      );
      expect(mockGetRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "heads/develop" }),
      );

      const mdDocs = batches
        .flatMap((b) => b.documents)
        .filter((d) => d.metadata.kind === "repository_file");
      expect(mdDocs).toHaveLength(1);
      expect(mdDocs[0].sourceUrl).toContain("/blob/develop/README.md");
    });

    test("continues when file content fetch fails", async () => {
      mockListForRepo.mockResolvedValueOnce({ data: [] });
      mockListForRepo.mockResolvedValueOnce({ data: [] });

      mockGetRef.mockResolvedValueOnce({
        data: { object: { sha: "abc123" } },
      });

      mockGetTree.mockResolvedValueOnce({
        data: {
          tree: [
            { type: "blob", path: "a.md", sha: "sha1" },
            { type: "blob", path: "b.md", sha: "sha2" },
          ],
        },
      });

      mockGetContent
        .mockRejectedValueOnce(new Error("403 Forbidden"))
        .mockResolvedValueOnce({
          data: {
            content: Buffer.from("# B file").toString("base64"),
          },
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeRepositoryFiles: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const mdBatch = batches.find((b) =>
        b.documents.some((d) => d.metadata.kind === "repository_file"),
      );
      expect(mdBatch).toBeDefined();
      expect(mdBatch?.documents).toHaveLength(1);
      expect(mdBatch?.documents[0].content).toBe("# B file");
      expect(mdBatch?.failures).toHaveLength(1);
      expect(mdBatch?.failures?.[0].itemId).toBe("a.md");
    });
  });

  describe("trailing slash normalization", () => {
    test("validates config with trailing slash", async () => {
      const result = await connector.validateConfig({
        githubUrl: "https://api.github.com/",
        owner: "test-org",
      });
      expect(result).toEqual({ valid: true });
    });

    test("validates config without trailing slash", async () => {
      const result = await connector.validateConfig({
        githubUrl: "https://api.github.com",
        owner: "test-org",
      });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("permission sync", () => {
    async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
      const out: T[] = [];
      for await (const item of gen) out.push(item);
      return out;
    }

    test("supportsPermissionSync is true", () => {
      expect(connector.supportsPermissionSync).toBe(true);
    });

    // Pins the metadata-field contract with content-sync: documents are
    // written with `repo` = `<owner>/<name>` (matching the container key), and
    // the delta pass's local-adoption scoping depends on exactly that field.
    test("scopeKeyForDocument maps content-sync document metadata to the repo scope key", () => {
      expect(
        connector.scopeKeyForDocument({ repo: "o/r", filePath: "a.md" }),
      ).toBe("repo:o/r");
      expect(connector.scopeKeyForDocument({})).toBeNull();
      expect(connector.scopeKeyForDocument({ repo: "" })).toBeNull();
    });

    test("syncPermissionSnapshot yields the repo container then every repo doc's assignment", async () => {
      mockReposGet.mockResolvedValue({
        data: { default_branch: "main", private: true },
      });
      mockListCollaborators.mockResolvedValue({ data: [{ login: "alice" }] });
      mockReposListTeams.mockResolvedValue({ data: [{ slug: "eng" }] });
      mockGetByUsername.mockImplementation(
        async ({ username }: { username: string }) => ({
          data: { email: `${username}@example.com` },
        }),
      );

      const readIngestedDocuments = vi.fn().mockResolvedValue({
        documents: [
          { sourceId: "my-repo#1", metadata: { repo: "test-org/my-repo" } },
          {
            sourceId: "my-repo#file:README.md",
            metadata: { repo: "test-org/my-repo" },
          },
        ],
        nextAfterId: null,
      });

      const yields = await collect(
        connector.syncPermissionSnapshot?.({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments,
        }) ?? (async function* () {})(),
      );

      expect(readIngestedDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          metadataFilter: { repo: "test-org/my-repo" },
        }),
      );
      expect(yields).toEqual([
        {
          kind: "container",
          containerKey: "repo:test-org/my-repo",
          cursor: "repo:test-org/my-repo",
          permissions: {
            isPublic: false,
            users: ["alice@example.com"],
            groups: ["test-org/eng"],
          },
          audienceResolutionFailed: false,
        },
        {
          kind: "document",
          sourceId: "my-repo#1",
          containerKey: "repo:test-org/my-repo",
          cursor: "repo:test-org/my-repo",
        },
        {
          kind: "document",
          sourceId: "my-repo#file:README.md",
          containerKey: "repo:test-org/my-repo",
          cursor: "repo:test-org/my-repo",
        },
      ]);
    });

    test("a mapped collaborator materializes via the injected mapping — even with a private GitHub email", async () => {
      mockReposGet.mockResolvedValue({
        data: { default_branch: "main", private: true },
      });
      mockListCollaborators.mockResolvedValue({
        data: [{ login: "hidden" }, { login: "alice" }],
      });
      mockReposListTeams.mockResolvedValue({ data: [] });
      // `hidden` keeps their email private; `alice` is public. The mapping
      // must take precedence for `hidden` (and only `hidden`).
      mockGetByUsername.mockImplementation(
        async ({ username }: { username: string }) => ({
          data: {
            email: username === "alice" ? "alice@example.com" : null,
          },
        }),
      );

      const yields = await collect(
        connector.syncPermissionSnapshot?.({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments: vi
            .fn()
            .mockResolvedValue({ documents: [], nextAfterId: null }),
          resolveMappedEmail: (accountId) =>
            accountId === "hidden" ? "mapped@example.com" : null,
        }) ?? (async function* () {})(),
      );

      expect(yields[0]).toMatchObject({
        kind: "container",
        permissions: {
          isPublic: false,
          users: ["mapped@example.com", "alice@example.com"],
        },
      });
    });

    test("a mapped collaborator with a public email materializes the upstream email — auto matching wins", async () => {
      mockReposGet.mockResolvedValue({
        data: { default_branch: "main", private: true },
      });
      mockListCollaborators.mockResolvedValue({ data: [{ login: "alice" }] });
      mockReposListTeams.mockResolvedValue({ data: [] });
      mockGetByUsername.mockResolvedValue({
        data: { email: "alice@example.com" },
      });

      const yields = await collect(
        connector.syncPermissionSnapshot?.({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments: vi
            .fn()
            .mockResolvedValue({ documents: [], nextAfterId: null }),
          // A stale admin mapping must NOT displace the source's identity.
          resolveMappedEmail: () => "someone-else@example.com",
        }) ?? (async function* () {})(),
      );

      expect(yields[0]).toMatchObject({
        kind: "container",
        permissions: { isPublic: false, users: ["alice@example.com"] },
      });
    });

    test("a public repo's container is isPublic and drops collaborators without a public email", async () => {
      mockReposGet.mockResolvedValue({
        data: { default_branch: "main", private: false },
      });
      mockListCollaborators.mockResolvedValue({ data: [{ login: "carol" }] });
      mockReposListTeams.mockResolvedValue({ data: [] });
      mockGetByUsername.mockResolvedValue({ data: { email: null } });

      const readIngestedDocuments = vi.fn().mockResolvedValue({
        documents: [{ sourceId: "my-repo#1", metadata: {} }],
        nextAfterId: null,
      });

      const yields = await collect(
        connector.syncPermissionSnapshot?.({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments,
        }) ?? (async function* () {})(),
      );

      expect(yields).toEqual([
        {
          kind: "container",
          containerKey: "repo:test-org/my-repo",
          cursor: "repo:test-org/my-repo",
          permissions: { isPublic: true, users: [], groups: [] },
          audienceResolutionFailed: false,
        },
        {
          kind: "document",
          sourceId: "my-repo#1",
          containerKey: "repo:test-org/my-repo",
          cursor: "repo:test-org/my-repo",
        },
      ]);
    });

    test("a failing repo metadata fetch fail-closes the repo instead of failing the pass", async () => {
      // Regression: a transient 429/5xx on repos.get propagated up and failed
      // the whole snapshot, unlike Jira/Confluence which fail-close the one
      // container and keep enumerating.
      mockReposGet.mockRejectedValue(new Error("boom (503)"));

      const readIngestedDocuments = vi.fn().mockResolvedValue({
        documents: [{ sourceId: "my-repo#1", metadata: {} }],
        nextAfterId: null,
      });

      const yields = await collect(
        connector.syncPermissionSnapshot?.({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments,
        }) ?? (async function* () {})(),
      );

      expect(yields).toEqual([
        {
          kind: "container",
          containerKey: "repo:test-org/my-repo",
          cursor: "repo:test-org/my-repo",
          permissions: { isPublic: false, users: [], groups: [] },
          // The empty audience here means "we could not read it", not "nobody
          // has access" — the pass counts it so the repo going dark is
          // attributable instead of looking like an ordinary empty audience.
          audienceResolutionFailed: true,
        },
        {
          kind: "document",
          sourceId: "my-repo#1",
          containerKey: "repo:test-org/my-repo",
          cursor: "repo:test-org/my-repo",
        },
      ]);
    });

    test("syncGroups expands org teams to members (email null when private)", async () => {
      mockReposGet.mockResolvedValue({
        data: { default_branch: "main" },
      });
      mockTeamsList.mockResolvedValue({ data: [{ slug: "eng" }] });
      mockListMembersInOrg.mockResolvedValue({
        data: [{ login: "alice" }, { login: "bob" }],
      });
      mockGetByUsername.mockImplementation(
        async ({ username }: { username: string }) => ({
          data: {
            email: username === "alice" ? "alice@example.com" : null,
          },
        }),
      );

      const yields = await collect(
        connector.syncGroups?.({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments: vi.fn(),
        }) ?? (async function* () {})(),
      );

      expect(yields).toEqual([
        {
          groupId: "test-org/eng",
          members: [
            {
              accountId: "alice",
              displayName: null,
              email: "alice@example.com",
            },
            // bob's email is private — recorded fail-closed, not dropped.
            { accountId: "bob", displayName: null, email: null },
          ],
          cursor: "test-org/eng",
        },
      ]);
    });

    test("a full pass bypasses the cached negative and sees a newly public email", async () => {
      mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
      mockTeamsList.mockResolvedValue({ data: [{ slug: "eng" }] });
      mockListMembersInOrg.mockResolvedValue({ data: [{ login: "bob" }] });

      // Pass 1: bob's email is private — the cross-pass cache stores the
      // negative.
      mockGetByUsername.mockResolvedValue({ data: { email: null } });
      await collect(
        connector.syncGroups?.({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments: vi.fn(),
        }) ?? (async function* () {})(),
      );

      // bob makes the email public upstream.
      mockGetByUsername.mockResolvedValue({
        data: { email: "bob@example.com" },
      });

      // A delta pass serves the cached negative (fresh instance drops the
      // per-pass cache; the cross-pass one persists).
      const deltaYields = await collect(
        new GithubConnector().syncGroups?.({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments: vi.fn(),
        }) ?? (async function* () {})(),
      );
      expect(deltaYields[0].members[0].email).toBeNull();

      // A full pass must re-resolve live — an admin's manual sync has to
      // observe the change immediately, not after the cache TTL.
      const fullYields = await collect(
        new GithubConnector().syncGroups?.({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments: vi.fn(),
          refreshIdentities: true,
        }) ?? (async function* () {})(),
      );
      expect(fullYields[0].members[0].email).toBe("bob@example.com");
    });
  });
});
