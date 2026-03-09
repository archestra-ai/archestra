import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types/knowledge-connector";
import { GitlabConnector } from "./gitlab-connector";

// Mock @gitbeaker/rest SDK
const mockShowCurrentUser = vi.fn();
const mockProjectsAll = vi.fn();
const mockProjectsShow = vi.fn();
const mockGroupsAllProjects = vi.fn();
const mockIssuesAll = vi.fn();
const mockIssueNotesAll = vi.fn();
const mockMergeRequestsAll = vi.fn();
const mockMergeRequestNotesAll = vi.fn();

vi.mock("@gitbeaker/rest", () => ({
  Gitlab: class MockGitlab {
    Users = { showCurrentUser: mockShowCurrentUser };
    Projects = { all: mockProjectsAll, show: mockProjectsShow };
    Groups = { allProjects: mockGroupsAllProjects };
    Issues = { all: mockIssuesAll };
    IssueNotes = { all: mockIssueNotesAll };
    MergeRequests = { all: mockMergeRequestsAll };
    MergeRequestNotes = { all: mockMergeRequestNotesAll };
  },
}));

describe("GitlabConnector", () => {
  let connector: GitlabConnector;

  const validConfig = {
    gitlabUrl: "https://gitlab.com",
    projectIds: [42],
  };

  const credentials = {
    apiToken: "glpat-test-token-123",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new GitlabConnector();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("validateConfig", () => {
    test("returns valid for correct config", async () => {
      const result = await connector.validateConfig(validConfig);
      expect(result).toEqual({ valid: true });
    });

    test("returns invalid when gitlabUrl is missing", async () => {
      const result = await connector.validateConfig({ projectIds: [42] });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("gitlabUrl");
    });

    test("returns invalid when gitlabUrl is not a valid URL", async () => {
      const result = await connector.validateConfig({
        gitlabUrl: "not-a-url",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("valid HTTP(S) URL");
    });

    test("accepts config with optional projectIds", async () => {
      const result = await connector.validateConfig({
        gitlabUrl: "https://gitlab.com",
        projectIds: [1, 2, 3],
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts config with groupId", async () => {
      const result = await connector.validateConfig({
        gitlabUrl: "https://gitlab.com",
        groupId: "my-group",
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts config with boolean flags", async () => {
      const result = await connector.validateConfig({
        gitlabUrl: "https://gitlab.com",
        includeIssues: true,
        includeMergeRequests: false,
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts self-hosted GitLab URL", async () => {
      const result = await connector.validateConfig({
        gitlabUrl: "https://gitlab.mycompany.com",
      });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("testConnection", () => {
    test("returns success when API responds OK", async () => {
      mockShowCurrentUser.mockResolvedValueOnce({
        id: 1,
        username: "test-user",
      });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockShowCurrentUser).toHaveBeenCalled();
    });

    test("returns error when API throws", async () => {
      mockShowCurrentUser.mockRejectedValueOnce(new Error("401 Unauthorized"));

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
      expect(result.error).toContain("Invalid GitLab configuration");
    });
  });

  describe("sync", () => {
    const mockProject = {
      id: 42,
      name: "my-project",
      path_with_namespace: "my-group/my-project",
      web_url: "https://gitlab.com/my-group/my-project",
    };

    function makeIssue(
      iid: number,
      title: string,
      opts?: { labels?: string[]; description?: string },
    ) {
      return {
        iid,
        title,
        description: opts?.description ?? `Description for ${title}`,
        state: "opened",
        web_url: `https://gitlab.com/my-group/my-project/-/issues/${iid}`,
        author: { username: "author", name: "Author Name" },
        labels: opts?.labels ?? [],
        updated_at: "2024-01-15T10:00:00.000Z",
      };
    }

    function makeMergeRequest(
      iid: number,
      title: string,
      opts?: { labels?: string[]; description?: string },
    ) {
      return {
        iid,
        title,
        description: opts?.description ?? `Description for ${title}`,
        state: "merged",
        web_url: `https://gitlab.com/my-group/my-project/-/merge_requests/${iid}`,
        author: { username: "author", name: "Author Name" },
        labels: opts?.labels ?? [],
        updated_at: "2024-01-15T10:00:00.000Z",
      };
    }

    beforeEach(() => {
      mockProjectsShow.mockResolvedValue(mockProject);
    });

    test("yields batch of documents from issues", async () => {
      const issues = [
        makeIssue(1, "First issue"),
        makeIssue(2, "Second issue"),
      ];

      mockIssuesAll.mockResolvedValueOnce(issues);
      mockIssueNotesAll.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      // MR pass
      mockMergeRequestsAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Issues batch + MR batch
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("my-group/my-project#issue-1");
      expect(batches[0].documents[0].title).toContain("First issue");
      expect(batches[0].documents[1].id).toBe("my-group/my-project#issue-2");
    });

    test("yields merge request documents", async () => {
      // Issues pass
      mockIssuesAll.mockResolvedValueOnce([]);

      const mrs = [
        makeMergeRequest(10, "Feature branch"),
        makeMergeRequest(11, "Bug fix"),
      ];
      mockMergeRequestsAll.mockResolvedValueOnce(mrs);
      mockMergeRequestNotesAll
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const mrBatch = batches.find((b) =>
        b.documents.some((d) => d.metadata.kind === "merge_request"),
      );
      expect(mrBatch).toBeDefined();
      expect(mrBatch?.documents).toHaveLength(2);
      expect(mrBatch?.documents[0].id).toBe("my-group/my-project#mr-10");
      expect(mrBatch?.documents[0].title).toContain("Feature branch");
      expect(mrBatch?.documents[0].title).toContain("!10");
    });

    test("includes notes in document content", async () => {
      mockIssuesAll.mockResolvedValueOnce([makeIssue(1, "Issue with notes")]);
      mockIssueNotesAll.mockResolvedValueOnce([
        {
          body: "This is a comment",
          author: { username: "reviewer", name: "Reviewer" },
          created_at: "2024-01-16T12:00:00.000Z",
          system: false,
        },
        {
          body: "assigned to @reviewer",
          author: { username: "system", name: "System" },
          created_at: "2024-01-16T11:00:00.000Z",
          system: true,
        },
      ]);

      // MR pass
      mockMergeRequestsAll.mockResolvedValueOnce([]);

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
      expect(content).toContain("**Reviewer**");
      expect(content).toContain("This is a comment");
      // System notes should be filtered out
      expect(content).not.toContain("assigned to");
    });

    test("paginates through multiple pages", async () => {
      const page1Issues = Array.from({ length: 50 }, (_, i) =>
        makeIssue(i + 1, `Issue ${i + 1}`),
      );
      const page2Issues = [makeIssue(51, "Issue 51")];

      mockIssuesAll
        .mockResolvedValueOnce(page1Issues)
        .mockResolvedValueOnce(page2Issues);

      // Notes for each issue
      for (let i = 0; i < 51; i++) {
        mockIssueNotesAll.mockResolvedValueOnce([]);
      }

      // MR pass
      mockMergeRequestsAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const issueBatches = batches.filter((b) =>
        b.documents.some((d) => d.metadata.kind === "issue"),
      );
      expect(issueBatches[0].documents).toHaveLength(50);
      expect(issueBatches[0].hasMore).toBe(true);
      expect(issueBatches[1].documents).toHaveLength(1);
    });

    test("incremental sync uses checkpoint timestamp", async () => {
      mockIssuesAll.mockResolvedValueOnce([]);
      mockMergeRequestsAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: { lastSyncedAt: "2024-01-10T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      expect(mockIssuesAll).toHaveBeenCalledWith(
        expect.objectContaining({
          updatedAfter: "2024-01-10T00:00:00.000Z",
        }),
      );
    });

    test("skips items with labels in labelsToSkip", async () => {
      const issues = [
        makeIssue(1, "Keep this"),
        makeIssue(2, "Skip this", { labels: ["wontfix"] }),
      ];

      mockIssuesAll.mockResolvedValueOnce(issues);
      mockIssueNotesAll.mockResolvedValueOnce([]);

      // MR pass
      mockMergeRequestsAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, labelsToSkip: ["wontfix"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const issueDocs = batches.flatMap((b) =>
        b.documents.filter((d) => d.metadata.kind === "issue"),
      );
      expect(issueDocs).toHaveLength(1);
      expect(issueDocs[0].title).toContain("Keep this");
    });

    test("respects includeIssues=false", async () => {
      // Only MR pass should run
      mockMergeRequestsAll.mockResolvedValueOnce([makeMergeRequest(1, "A MR")]);
      mockMergeRequestNotesAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeIssues: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs.every((d) => d.metadata.kind === "merge_request")).toBe(
        true,
      );
      expect(mockIssuesAll).not.toHaveBeenCalled();
    });

    test("respects includeMergeRequests=false", async () => {
      mockIssuesAll.mockResolvedValueOnce([makeIssue(1, "An issue")]);
      mockIssueNotesAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeMergeRequests: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs.every((d) => d.metadata.kind === "issue")).toBe(true);
      expect(mockMergeRequestsAll).not.toHaveBeenCalled();
    });

    test("builds source URL correctly for issues", async () => {
      mockIssuesAll.mockResolvedValueOnce([makeIssue(5, "Test issue")]);
      mockIssueNotesAll.mockResolvedValueOnce([]);
      mockMergeRequestsAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://gitlab.com/my-group/my-project/-/issues/5",
      );
    });

    test("includes metadata in documents", async () => {
      mockIssuesAll.mockResolvedValueOnce([
        makeIssue(1, "Test issue", { labels: ["bug", "urgent"] }),
      ]);
      mockIssueNotesAll.mockResolvedValueOnce([]);
      mockMergeRequestsAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.project).toBe("my-group/my-project");
      expect(metadata.iid).toBe(1);
      expect(metadata.state).toBe("opened");
      expect(metadata.kind).toBe("issue");
      expect(metadata.labels).toEqual(["bug", "urgent"]);
      expect(metadata.author).toBe("author");
    });

    test("throws on API error", async () => {
      mockIssuesAll.mockRejectedValueOnce(
        new Error("Request failed with status code 403"),
      );

      const generator = connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow();
    });

    test("fetches projects from group when groupId specified", async () => {
      const configWithGroup = {
        gitlabUrl: "https://gitlab.com",
        groupId: "my-group",
      };

      mockGroupsAllProjects.mockResolvedValueOnce([mockProject]);
      mockIssuesAll.mockResolvedValueOnce([]);
      mockMergeRequestsAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: configWithGroup,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockGroupsAllProjects).toHaveBeenCalledWith("my-group", {
        perPage: 100,
      });
    });

    test("fetches member projects when no filter specified", async () => {
      const configNoFilter = {
        gitlabUrl: "https://gitlab.com",
      };

      mockProjectsAll.mockResolvedValueOnce([mockProject]);
      mockIssuesAll.mockResolvedValueOnce([]);
      mockMergeRequestsAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: configNoFilter,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockProjectsAll).toHaveBeenCalledWith(
        expect.objectContaining({ membership: true }),
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

      mockIssuesAll.mockResolvedValueOnce(issues);
      mockIssueNotesAll.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockMergeRequestsAll.mockResolvedValueOnce([]);

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
      expect(checkpoint.type).toBe("gitlab");
      expect(checkpoint.lastSyncedAt).toBe("2024-06-20T15:30:00.000Z");
    });

    test("checkpoint preserves previous value when batch has no items", async () => {
      mockIssuesAll.mockResolvedValueOnce([]);
      mockMergeRequestsAll.mockResolvedValueOnce([]);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "gitlab",
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
        gitlabUrl: "https://gitlab.com/",
      });
      expect(result).toEqual({ valid: true });
    });

    test("validates config without trailing slash", async () => {
      const result = await connector.validateConfig({
        gitlabUrl: "https://gitlab.com",
      });
      expect(result).toEqual({ valid: true });
    });
  });
});
