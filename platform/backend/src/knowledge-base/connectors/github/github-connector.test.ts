import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types/knowledge-connector";
import { GithubConnector } from "./github-connector";

// Mock @octokit/rest SDK
const mockGetAuthenticated = vi.fn();
const mockListForRepo = vi.fn();
const mockListForOrg = vi.fn();
const mockListComments = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    rest = {
      users: { getAuthenticated: mockGetAuthenticated },
      repos: { listForOrg: mockListForOrg },
      issues: {
        listForRepo: mockListForRepo,
        listComments: mockListComments,
      },
    };
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
    connector = new GithubConnector();
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

    test("returns invalid when githubUrl is not a valid URL", async () => {
      const result = await connector.validateConfig({
        githubUrl: "not-a-url",
        owner: "test-org",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("valid HTTP(S) URL");
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
          { name: "repo-a", html_url: "https://github.com/test-org/repo-a" },
          { name: "repo-b", html_url: "https://github.com/test-org/repo-b" },
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
});
