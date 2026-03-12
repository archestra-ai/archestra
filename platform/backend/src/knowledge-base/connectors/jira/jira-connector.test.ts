import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types/knowledge-connector";
import {
  extractTextFromAdf,
  formatJiraLocalDate,
  JiraConnector,
} from "./jira-connector";

// Mock jira.js SDK
const mockGetCurrentUser = vi.fn();
const mockEnhancedSearchPost = vi.fn();
const mockSearchForIssuesUsingJql = vi.fn();
const mockSearchForIssuesUsingJqlPost = vi.fn();
const capturedConfigs: { type: string; config: Record<string, unknown> }[] = [];

vi.mock("jira.js", () => ({
  ClientType: { Version2: "Version2", Version3: "Version3" },
  // biome-ignore lint/suspicious/noExplicitAny: mock factory
  createClient: (type: any, config: any) => {
    capturedConfigs.push({ type, config });
    return {
      myself: { getCurrentUser: mockGetCurrentUser },
      issueSearch: {
        searchForIssuesUsingJqlEnhancedSearchPost: mockEnhancedSearchPost,
        searchForIssuesUsingJql: mockSearchForIssuesUsingJql,
        searchForIssuesUsingJqlPost: mockSearchForIssuesUsingJqlPost,
      },
    };
  },
}));

describe("JiraConnector", () => {
  let connector: JiraConnector;

  const validConfig = {
    jiraBaseUrl: "https://mysite.atlassian.net",
    isCloud: true,
    projectKey: "PROJ",
  };

  const credentials = {
    email: "user@example.com",
    apiToken: "test-api-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedConfigs.length = 0;
    connector = new JiraConnector();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("validateConfig", () => {
    test("returns valid for correct config", async () => {
      const result = await connector.validateConfig(validConfig);
      expect(result).toEqual({ valid: true });
    });

    test("returns invalid when jiraBaseUrl is missing", async () => {
      const result = await connector.validateConfig({ isCloud: true });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("jiraBaseUrl");
    });

    test("returns invalid when isCloud is missing", async () => {
      const result = await connector.validateConfig({
        jiraBaseUrl: "https://mysite.atlassian.net",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("isCloud");
    });

    test("returns invalid when jiraBaseUrl uses unsupported protocol", async () => {
      const result = await connector.validateConfig({
        jiraBaseUrl: "ftp://jira.example.com",
        isCloud: true,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("valid HTTP(S) URL");
    });

    test("accepts server config with isCloud false", async () => {
      const result = await connector.validateConfig({
        jiraBaseUrl: "https://jira.mycompany.com",
        isCloud: false,
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts URL without protocol by prepending https://", async () => {
      const result = await connector.validateConfig({
        jiraBaseUrl: "mycompany.atlassian.net",
        isCloud: true,
      });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("testConnection", () => {
    test("returns success when API responds OK", async () => {
      mockGetCurrentUser.mockResolvedValueOnce({
        displayName: "Test User",
        active: true,
      });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockGetCurrentUser).toHaveBeenCalled();
    });

    test("returns success for server instances", async () => {
      mockGetCurrentUser.mockResolvedValueOnce({
        displayName: "Test User",
      });

      const result = await connector.testConnection({
        config: { ...validConfig, isCloud: false },
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockGetCurrentUser).toHaveBeenCalled();
    });

    test("returns error when API throws", async () => {
      mockGetCurrentUser.mockRejectedValueOnce(new Error("401 Unauthorized"));

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
      expect(result.error).toContain("Invalid Jira configuration");
    });

    test("uses basic auth for server when email is provided", async () => {
      mockGetCurrentUser.mockResolvedValueOnce({ displayName: "User" });

      await connector.testConnection({
        config: { ...validConfig, isCloud: false },
        credentials: { email: "admin", apiToken: "password123" },
      });

      const serverConfig = capturedConfigs.find(
        (c) => c.type === "Version2",
      )?.config;
      expect(serverConfig?.authentication).toEqual({
        basic: { email: "admin", apiToken: "password123" },
      });
    });

    test("uses oauth2 (PAT) auth for server when email is not provided", async () => {
      mockGetCurrentUser.mockResolvedValueOnce({ displayName: "User" });

      await connector.testConnection({
        config: { ...validConfig, isCloud: false },
        credentials: { apiToken: "pat-token-value" },
      });

      const serverConfig = capturedConfigs.find(
        (c) => c.type === "Version2",
      )?.config;
      expect(serverConfig?.authentication).toEqual({
        oauth2: { accessToken: "pat-token-value" },
      });
    });

    test("sets noCheckAtlassianToken for server instances", async () => {
      mockGetCurrentUser.mockResolvedValueOnce({ displayName: "User" });

      await connector.testConnection({
        config: { ...validConfig, isCloud: false },
        credentials: { apiToken: "pat-token" },
      });

      const serverConfig = capturedConfigs.find(
        (c) => c.type === "Version2",
      )?.config;
      expect(serverConfig?.noCheckAtlassianToken).toBe(true);
    });

    test("uses basic auth for cloud instances", async () => {
      mockGetCurrentUser.mockResolvedValueOnce({ displayName: "User" });

      await connector.testConnection({
        config: validConfig,
        credentials,
      });

      const cloudConfig = capturedConfigs.find(
        (c) => c.type === "Version3",
      )?.config;
      expect(cloudConfig?.authentication).toEqual({
        basic: { email: "user@example.com", apiToken: "test-api-token" },
      });
    });
  });

  describe("sync", () => {
    function makeIssue(
      key: string,
      summary: string,
      description: unknown = "Description text",
    ) {
      return {
        key,
        fields: {
          summary,
          description,
          comment: { comments: [] as Record<string, unknown>[] },
          reporter: {
            displayName: "Reporter",
            emailAddress: "reporter@example.com",
          },
          assignee: {
            displayName: "Assignee",
            emailAddress: "assignee@example.com",
          },
          priority: { name: "Medium" },
          status: { name: "Open" },
          labels: [] as string[],
          issuetype: { name: "Task" },
          updated: "2024-01-15T10:00:00.000Z",
        },
      };
    }

    test("yields batch of documents from search results", async () => {
      const issues = [
        makeIssue("PROJ-1", "First issue"),
        makeIssue("PROJ-2", "Second issue"),
      ];

      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues,
        nextPageToken: null,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("PROJ-1");
      expect(batches[0].documents[0].title).toBe("First issue");
      expect(batches[0].documents[1].id).toBe("PROJ-2");
      expect(batches[0].hasMore).toBe(false);
    });

    test("passes JQL and fields to search", async () => {
      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: [],
        nextPageToken: null,
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockEnhancedSearchPost).toHaveBeenCalledWith(
        expect.objectContaining({
          jql: expect.stringContaining('project = "PROJ"'),
          fields: expect.arrayContaining(["summary", "description"]),
          maxResults: 50,
        }),
      );
    });

    test("paginates through multiple pages", async () => {
      const page1Issues = Array.from({ length: 50 }, (_, i) =>
        makeIssue(`PROJ-${i + 1}`, `Issue ${i + 1}`),
      );
      const page2Issues = [makeIssue("PROJ-51", "Issue 51")];

      mockEnhancedSearchPost
        .mockResolvedValueOnce({
          issues: page1Issues,
          nextPageToken: "next-page-token",
        })
        .mockResolvedValueOnce({
          issues: page2Issues,
          nextPageToken: null,
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].documents).toHaveLength(50);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].documents).toHaveLength(1);
      expect(batches[1].hasMore).toBe(false);

      // Second call should include the nextPageToken
      expect(mockEnhancedSearchPost).toHaveBeenCalledTimes(2);
      expect(mockEnhancedSearchPost.mock.calls[1][0]).toEqual(
        expect.objectContaining({ nextPageToken: "next-page-token" }),
      );
    });

    test("incremental sync with old checkpoint (no lastRawUpdatedAt) applies 14-hour safety buffer", async () => {
      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: [],
        nextPageToken: null,
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: { lastSyncedAt: "2024-01-10T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      // 2024-01-10T00:00Z minus 14 hours = 2024-01-09T10:00Z
      const callArgs = mockEnhancedSearchPost.mock.calls[0][0];
      expect(callArgs.jql).toContain('updated >= "2024/01/09 10:00"');
    });

    test("incremental sync with lastRawUpdatedAt uses local date extraction", async () => {
      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: [],
        nextPageToken: null,
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "jira",
          lastSyncedAt: "2024-06-20T15:30:00.000Z",
          lastRawUpdatedAt: "2024-06-20T11:30:00.774-0400",
        },
      })) {
        batches.push(batch);
      }

      // Should extract local components from raw timestamp (11:30 EDT), NOT convert from UTC
      const callArgs = mockEnhancedSearchPost.mock.calls[0][0];
      expect(callArgs.jql).toContain('updated >= "2024/06/20 11:30"');
    });

    test("skips issues with labels in labelsToSkip", async () => {
      const issues = [
        makeIssue("PROJ-1", "Keep this"),
        {
          ...makeIssue("PROJ-2", "Skip this"),
          fields: {
            ...makeIssue("PROJ-2", "Skip this").fields,
            labels: ["internal"],
          },
        },
      ];

      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues,
        nextPageToken: null,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, labelsToSkip: ["internal"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("PROJ-1");
    });

    test("filters comments by email blacklist", async () => {
      const issue = makeIssue("PROJ-1", "With comments");
      issue.fields.comment = {
        comments: [
          {
            body: "Good comment",
            author: {
              displayName: "User",
              emailAddress: "user@example.com",
            },
            created: "2024-01-15T10:00:00.000Z",
          },
          {
            body: "Bot comment",
            author: {
              displayName: "Bot",
              emailAddress: "bot@example.com",
            },
            created: "2024-01-15T11:00:00.000Z",
          },
        ],
      };

      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: [issue],
        nextPageToken: null,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          commentEmailBlacklist: ["bot@example.com"],
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const content = batches[0].documents[0].content;
      expect(content).toContain("Good comment");
      expect(content).not.toContain("Bot comment");
    });

    test("builds source URL correctly", async () => {
      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: [makeIssue("PROJ-1", "Test issue")],
        nextPageToken: null,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://mysite.atlassian.net/browse/PROJ-1",
      );
    });

    test("includes metadata in documents", async () => {
      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: [makeIssue("PROJ-1", "Test issue")],
        nextPageToken: null,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.issueKey).toBe("PROJ-1");
      expect(metadata.status).toBe("Open");
      expect(metadata.priority).toBe("Medium");
      expect(metadata.reporter).toBe("Reporter");
      expect(metadata.assignee).toBe("Assignee");
      expect(metadata.issueType).toBe("Task");
    });

    test("checkpoint stores lastRawUpdatedAt and lastIssueKey from last issue", async () => {
      const issues = [
        makeIssue("PROJ-1", "First issue"),
        {
          ...makeIssue("PROJ-2", "Second issue"),
          fields: {
            ...makeIssue("PROJ-2", "Second issue").fields,
            updated: "2024-06-20T11:30:00.774-0400",
          },
        },
      ];

      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues,
        nextPageToken: null,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const checkpoint = batches[0].checkpoint as {
        lastSyncedAt?: string;
        lastIssueKey?: string;
        lastRawUpdatedAt?: string;
      };
      // lastSyncedAt is the UTC conversion of the raw timestamp
      expect(checkpoint.lastSyncedAt).toBe("2024-06-20T15:30:00.774Z");
      expect(checkpoint.lastIssueKey).toBe("PROJ-2");
      // Raw timestamp preserved for correct JQL date formatting
      expect(checkpoint.lastRawUpdatedAt).toBe("2024-06-20T11:30:00.774-0400");
    });

    test("checkpoint preserves previous value when batch has no issues", async () => {
      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: [],
        nextPageToken: null,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "jira",
          lastSyncedAt: "2024-01-10T00:00:00.000Z",
          lastIssueKey: "PROJ-99",
        },
      })) {
        batches.push(batch);
      }

      const checkpoint = batches[0].checkpoint as {
        lastSyncedAt?: string;
        lastIssueKey?: string;
      };
      expect(checkpoint.lastSyncedAt).toBe("2024-01-10T00:00:00.000Z");
      expect(checkpoint.lastIssueKey).toBe("PROJ-99");
    });

    test("incremental sync picks up issues updated after checkpoint", async () => {
      // First sync: returns 2 issues, last one updated at a specific time
      const firstSyncIssues = [
        {
          ...makeIssue("PROJ-1", "Issue 1"),
          fields: {
            ...makeIssue("PROJ-1", "Issue 1").fields,
            updated: "2024-06-20T10:00:00.000Z",
          },
        },
        {
          ...makeIssue("PROJ-2", "Issue 2"),
          fields: {
            ...makeIssue("PROJ-2", "Issue 2").fields,
            updated: "2024-06-20T12:00:00.000Z",
          },
        },
      ];

      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: firstSyncIssues,
        nextPageToken: null,
      });

      const firstBatches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        firstBatches.push(batch);
      }

      const savedCheckpoint = firstBatches[0].checkpoint;

      // Second sync: an issue was updated at 12:05 (after last issue's 12:00 timestamp)
      const updatedIssue = {
        ...makeIssue("PROJ-1", "Issue 1 - updated"),
        fields: {
          ...makeIssue("PROJ-1", "Issue 1 - updated").fields,
          updated: "2024-06-20T12:05:00.000Z",
        },
      };

      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: [updatedIssue],
        nextPageToken: null,
      });

      const secondBatches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: savedCheckpoint,
      })) {
        secondBatches.push(batch);
      }

      // The JQL should use the last issue's updated timestamp
      const jql = mockEnhancedSearchPost.mock.calls[1][0].jql;
      expect(jql).toContain('updated >= "2024/06/20 12:00"');

      // Should find the updated issue
      expect(secondBatches[0].documents).toHaveLength(1);
      expect(secondBatches[0].documents[0].title).toBe("Issue 1 - updated");
    });

    test("throws on search API error", async () => {
      mockEnhancedSearchPost.mockRejectedValueOnce(
        new Error("Request failed with status code 400"),
      );

      const generator = connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow();
    });
  });

  describe("sync (server / isCloud=false)", () => {
    const serverConfig = {
      jiraBaseUrl: "https://jira.mycompany.com",
      isCloud: false,
      projectKey: "SRV",
    };

    function makeIssue(
      key: string,
      summary: string,
      description: unknown = "Description text",
    ) {
      return {
        key,
        fields: {
          summary,
          description,
          comment: { comments: [] as Record<string, unknown>[] },
          reporter: { displayName: "Reporter" },
          assignee: { displayName: "Assignee" },
          priority: { name: "Medium" },
          status: { name: "Open" },
          labels: [] as string[],
          issuetype: { name: "Task" },
          updated: "2024-01-15T10:00:00.000Z",
        },
      };
    }

    test("uses searchForIssuesUsingJqlPost instead of enhanced search", async () => {
      mockSearchForIssuesUsingJqlPost.mockResolvedValueOnce({
        issues: [makeIssue("SRV-1", "Server issue")],
        startAt: 0,
        maxResults: 50,
        total: 1,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: serverConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockSearchForIssuesUsingJqlPost).toHaveBeenCalledTimes(1);
      expect(mockEnhancedSearchPost).not.toHaveBeenCalled();
      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("SRV-1");
    });

    test("uses offset-based pagination with startAt", async () => {
      const page1Issues = Array.from({ length: 50 }, (_, i) =>
        makeIssue(`SRV-${i + 1}`, `Issue ${i + 1}`),
      );
      const page2Issues = [makeIssue("SRV-51", "Issue 51")];

      mockSearchForIssuesUsingJqlPost
        .mockResolvedValueOnce({
          issues: page1Issues,
          startAt: 0,
          maxResults: 50,
          total: 51,
        })
        .mockResolvedValueOnce({
          issues: page2Issues,
          startAt: 50,
          maxResults: 50,
          total: 51,
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: serverConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].documents).toHaveLength(50);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].documents).toHaveLength(1);
      expect(batches[1].hasMore).toBe(false);

      // Second call should use startAt=50
      expect(mockSearchForIssuesUsingJqlPost).toHaveBeenCalledTimes(2);
      expect(mockSearchForIssuesUsingJqlPost.mock.calls[1][0]).toEqual(
        expect.objectContaining({ startAt: 50, maxResults: 50 }),
      );
    });

    test("stops when fewer results than BATCH_SIZE returned", async () => {
      mockSearchForIssuesUsingJqlPost.mockResolvedValueOnce({
        issues: [makeIssue("SRV-1", "Only issue")],
        startAt: 0,
        maxResults: 50,
        total: 1,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: serverConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].hasMore).toBe(false);
      expect(mockSearchForIssuesUsingJqlPost).toHaveBeenCalledTimes(1);
    });
  });

  describe("trailing slash normalization", () => {
    test("validates config with trailing slash", async () => {
      const result = await connector.validateConfig({
        jiraBaseUrl: "https://mycompany.atlassian.net/",
        isCloud: true,
      });
      expect(result).toEqual({ valid: true });
    });

    test("validates config without trailing slash", async () => {
      const result = await connector.validateConfig({
        jiraBaseUrl: "https://mycompany.atlassian.net",
        isCloud: true,
      });
      expect(result).toEqual({ valid: true });
    });

    test("source URLs are identical regardless of trailing slash in config", async () => {
      function makeIssue(key: string) {
        return {
          key,
          fields: {
            summary: "Test",
            description: "Desc",
            comment: { comments: [] },
            reporter: { displayName: "R" },
            assignee: { displayName: "A" },
            priority: { name: "Medium" },
            status: { name: "Open" },
            labels: [],
            issuetype: { name: "Task" },
            updated: "2024-01-15T10:00:00.000Z",
          },
        };
      }

      // Test with trailing slash
      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: [makeIssue("PROJ-1")],
        nextPageToken: null,
      });

      const batchesWithSlash: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          jiraBaseUrl: "https://mycompany.atlassian.net/",
          isCloud: true,
          projectKey: "PROJ",
        },
        credentials,
        checkpoint: null,
      })) {
        batchesWithSlash.push(batch);
      }

      // Test without trailing slash
      mockEnhancedSearchPost.mockResolvedValueOnce({
        issues: [makeIssue("PROJ-1")],
        nextPageToken: null,
      });

      const batchesWithoutSlash: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          jiraBaseUrl: "https://mycompany.atlassian.net",
          isCloud: true,
          projectKey: "PROJ",
        },
        credentials,
        checkpoint: null,
      })) {
        batchesWithoutSlash.push(batch);
      }

      expect(batchesWithSlash[0].documents[0].sourceUrl).toBe(
        "https://mycompany.atlassian.net/browse/PROJ-1",
      );
      expect(batchesWithoutSlash[0].documents[0].sourceUrl).toBe(
        "https://mycompany.atlassian.net/browse/PROJ-1",
      );
      expect(batchesWithSlash[0].documents[0].sourceUrl).toBe(
        batchesWithoutSlash[0].documents[0].sourceUrl,
      );
    });
  });

  describe("formatJiraLocalDate", () => {
    test("extracts local date/time from timestamp with negative offset", () => {
      expect(formatJiraLocalDate("2026-03-09T11:05:52.774-0400")).toBe(
        "2026/03/09 11:05",
      );
    });

    test("extracts local date/time from timestamp with positive offset", () => {
      expect(formatJiraLocalDate("2026-03-09T23:30:00.000+0530")).toBe(
        "2026/03/09 23:30",
      );
    });

    test("extracts local date/time from UTC timestamp (Z suffix)", () => {
      expect(formatJiraLocalDate("2024-06-20T15:30:00.000Z")).toBe(
        "2024/06/20 15:30",
      );
    });

    test("falls back to UTC formatting for date-only strings", () => {
      // "2024-06-20" doesn't match the local-extraction regex (no T), so falls back to formatJiraDate
      expect(formatJiraLocalDate("2024-06-20")).toBe("2024/06/20 00:00");
    });
  });

  describe("extractTextFromAdf", () => {
    test("returns empty string for null", () => {
      expect(extractTextFromAdf(null)).toBe("");
    });

    test("returns empty string for undefined", () => {
      expect(extractTextFromAdf(undefined)).toBe("");
    });

    test("returns string as-is", () => {
      expect(extractTextFromAdf("plain text")).toBe("plain text");
    });

    test("extracts text from simple ADF document", () => {
      const adf = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Hello world" }],
          },
        ],
      };
      expect(extractTextFromAdf(adf)).toContain("Hello world");
    });

    test("extracts text from nested ADF structure", () => {
      const adf = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "First " },
              { type: "text", text: "paragraph" },
            ],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Second paragraph" }],
          },
        ],
      };
      const text = extractTextFromAdf(adf);
      expect(text).toContain("First paragraph");
      expect(text).toContain("Second paragraph");
    });

    test("handles ADF with bullet list", () => {
      const adf = {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Item 1" }],
                  },
                ],
              },
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Item 2" }],
                  },
                ],
              },
            ],
          },
        ],
      };
      const text = extractTextFromAdf(adf);
      expect(text).toContain("Item 1");
      expect(text).toContain("Item 2");
    });

    test("handles empty ADF content", () => {
      const adf = { type: "doc", content: [] };
      expect(extractTextFromAdf(adf)).toBe("");
    });
  });
});
