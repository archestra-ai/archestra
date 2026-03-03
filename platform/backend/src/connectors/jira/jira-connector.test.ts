import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { extractTextFromAdf, JiraConnector } from "./jira-connector";
import type { JiraSearchResponse } from "./types";

const mockFetch = vi.fn();
global.fetch = mockFetch;

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

    test("returns invalid when jiraBaseUrl is not a valid URL", async () => {
      const result = await connector.validateConfig({
        jiraBaseUrl: "not-a-url",
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
  });

  describe("testConnection", () => {
    test("returns success when API responds OK", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ displayName: "Test User", active: true }),
      });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://mysite.atlassian.net/rest/api/3/myself",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Basic "),
          }),
        }),
      );
    });

    test("uses API v2 for server instances", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ displayName: "Test User" }),
      });

      await connector.testConnection({
        config: { ...validConfig, isCloud: false },
        credentials,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/rest/api/2/myself"),
        expect.anything(),
      );
    });

    test("returns error when API responds with error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

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
  });

  describe("sync", () => {
    function makeSearchResponse(
      issues: JiraSearchResponse["issues"],
      total?: number,
    ): JiraSearchResponse {
      return {
        issues,
        startAt: 0,
        maxResults: 50,
        total: total ?? issues.length,
      };
    }

    function makeIssue(
      key: string,
      summary: string,
      description: unknown = "Description text",
    ): JiraSearchResponse["issues"][0] {
      return {
        key,
        fields: {
          summary,
          description,
          comment: { comments: [] },
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
          labels: [],
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

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse(issues)),
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

    test("uses POST for cloud search", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse([])),
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, isCloud: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockFetch).toHaveBeenCalledWith(
        "https://mysite.atlassian.net/rest/api/3/search",
        expect.objectContaining({ method: "POST" }),
      );
    });

    test("uses GET for server search", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse([])),
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, isCloud: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/rest/api/2/search?"),
        expect.objectContaining({ method: "GET" }),
      );
    });

    test("paginates through multiple pages", async () => {
      const page1Issues = Array.from({ length: 50 }, (_, i) =>
        makeIssue(`PROJ-${i + 1}`, `Issue ${i + 1}`),
      );
      const page2Issues = [makeIssue("PROJ-51", "Issue 51")];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              issues: page1Issues,
              startAt: 0,
              maxResults: 50,
              total: 51,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              issues: page2Issues,
              startAt: 50,
              maxResults: 50,
              total: 51,
            }),
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
    });

    test("incremental sync uses checkpoint timestamp", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse([])),
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: { lastSyncedAt: "2024-01-10T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.jql).toContain('updated >= "2024/01/10 00:00"');
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

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse(issues)),
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

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse([issue])),
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
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            makeSearchResponse([makeIssue("PROJ-1", "Test issue")]),
          ),
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
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            makeSearchResponse([makeIssue("PROJ-1", "Test issue")]),
          ),
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

    test("throws on search API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad JQL"),
      });

      const generator = connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow("Jira search failed");
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

// Import the sync batch type for typing
import type { ConnectorSyncBatch } from "../types";
