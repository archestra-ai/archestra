import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { ConnectorSyncBatch } from "@/types";
import {
  extractTextFromAdf,
  formatJiraLocalDate,
  JiraConnector,
} from "./jira-connector";

// Wire-level (MSW) mocking: the real jira.js client runs and only the HTTP
// boundary is faked. jira.js uses axios under the hood, which MSW intercepts.
const CLOUD_HOST = "https://mysite.atlassian.net";
const SERVER_HOST = "https://jira.mycompany.com";
const COMPANY_HOST = "https://mycompany.atlassian.net";

describe("JiraConnector", () => {
  const server = useMswServer();
  let connector: JiraConnector;

  // Captured wire traffic, reset per test.
  const myselfHeaders: Headers[] = [];
  const enhancedSearchBodies: Array<Record<string, unknown>> = [];
  const v2SearchBodies: Array<Record<string, unknown>> = [];

  function myselfHandler(opts: {
    version: 2 | 3;
    host: string;
    status?: number;
  }) {
    return http.get(
      `${opts.host}/rest/api/${opts.version}/myself`,
      ({ request }) => {
        myselfHeaders.push(request.headers);
        if (opts.status) {
          return HttpResponse.json(
            { errorMessages: ["Unauthorized"] },
            { status: opts.status },
          );
        }
        return HttpResponse.json({ displayName: "Test User", active: true });
      },
    );
  }

  function enhancedSearchHandler(pages: unknown[], host = CLOUD_HOST) {
    let call = 0;
    return http.post(`${host}/rest/api/3/search/jql`, async ({ request }) => {
      enhancedSearchBodies.push(
        (await request.json()) as Record<string, unknown>,
      );
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return HttpResponse.json(page as Record<string, unknown>);
    });
  }

  function enhancedSearchErrorHandler(status: number, host = CLOUD_HOST) {
    return http.post(`${host}/rest/api/3/search/jql`, () =>
      HttpResponse.json({ errorMessages: ["Bad Request"] }, { status }),
    );
  }

  function v2SearchHandler(pages: unknown[], host = SERVER_HOST) {
    let call = 0;
    return http.post(`${host}/rest/api/2/search`, async ({ request }) => {
      v2SearchBodies.push((await request.json()) as Record<string, unknown>);
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return HttpResponse.json(page as Record<string, unknown>);
    });
  }

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
    myselfHeaders.length = 0;
    enhancedSearchBodies.length = 0;
    v2SearchBodies.length = 0;
    connector = new JiraConnector();
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
      server.use(myselfHandler({ version: 3, host: CLOUD_HOST }));

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(myselfHeaders).toHaveLength(1);
    });

    test("returns success for server instances", async () => {
      server.use(myselfHandler({ version: 2, host: SERVER_HOST }));

      const result = await connector.testConnection({
        config: { ...validConfig, jiraBaseUrl: SERVER_HOST, isCloud: false },
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(myselfHeaders).toHaveLength(1);
    });

    test("returns error when API throws", async () => {
      server.use(myselfHandler({ version: 3, host: CLOUD_HOST, status: 401 }));

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
      server.use(myselfHandler({ version: 2, host: SERVER_HOST }));

      await connector.testConnection({
        config: { ...validConfig, jiraBaseUrl: SERVER_HOST, isCloud: false },
        credentials: { email: "admin", apiToken: "password123" },
      });

      const expected = `Basic ${Buffer.from("admin:password123").toString("base64")}`;
      expect(myselfHeaders[0].get("authorization")).toBe(expected);
    });

    test("uses oauth2 (PAT) auth for server when email is not provided", async () => {
      server.use(myselfHandler({ version: 2, host: SERVER_HOST }));

      await connector.testConnection({
        config: { ...validConfig, jiraBaseUrl: SERVER_HOST, isCloud: false },
        credentials: { apiToken: "pat-token-value" },
      });

      expect(myselfHeaders[0].get("authorization")).toBe(
        "Bearer pat-token-value",
      );
    });

    test("sets noCheckAtlassianToken for server instances", async () => {
      server.use(myselfHandler({ version: 2, host: SERVER_HOST }));

      await connector.testConnection({
        config: { ...validConfig, jiraBaseUrl: SERVER_HOST, isCloud: false },
        credentials: { apiToken: "pat-token" },
      });

      expect(myselfHeaders[0].get("x-atlassian-token")).toBe("no-check");
    });

    test("uses basic auth for cloud instances", async () => {
      server.use(myselfHandler({ version: 3, host: CLOUD_HOST }));

      await connector.testConnection({
        config: validConfig,
        credentials,
      });

      const expected = `Basic ${Buffer.from("user@example.com:test-api-token").toString("base64")}`;
      expect(myselfHeaders[0].get("authorization")).toBe(expected);
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
          project: { key: "PROJ", name: "Project" },
          parent: { key: "PROJ-0" },
          resolution: { name: "Done" },
          resolutiondate: "2024-01-20T10:00:00.000Z",
          created: "2024-01-01T10:00:00.000Z",
          duedate: "2024-02-01T10:00:00.000Z",
        },
      };
    }

    test("yields batch of documents from search results", async () => {
      const issues = [
        makeIssue("PROJ-1", "First issue"),
        makeIssue("PROJ-2", "Second issue"),
      ];

      server.use(enhancedSearchHandler([{ issues, nextPageToken: null }]));

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
      server.use(enhancedSearchHandler([{ issues: [], nextPageToken: null }]));

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(enhancedSearchBodies[0]).toEqual(
        expect.objectContaining({
          jql: expect.stringContaining('project = "PROJ"'),
          fields: expect.arrayContaining(["summary", "description"]),
          maxResults: 50,
        }),
      );
    });

    test("builds project IN JQL for multiple project keys", async () => {
      server.use(enhancedSearchHandler([{ issues: [], nextPageToken: null }]));

      const batches = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          projectKey: "ENG, OPS",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(enhancedSearchBodies[0]).toEqual(
        expect.objectContaining({
          jql: expect.stringContaining('project IN ("ENG", "OPS")'),
        }),
      );
    });

    test("paginates through multiple pages", async () => {
      const page1Issues = Array.from({ length: 50 }, (_, i) =>
        makeIssue(`PROJ-${i + 1}`, `Issue ${i + 1}`),
      );
      const page2Issues = [makeIssue("PROJ-51", "Issue 51")];

      server.use(
        enhancedSearchHandler([
          { issues: page1Issues, nextPageToken: "next-page-token" },
          { issues: page2Issues, nextPageToken: null },
        ]),
      );

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
      expect(enhancedSearchBodies).toHaveLength(2);
      expect(enhancedSearchBodies[1]).toEqual(
        expect.objectContaining({ nextPageToken: "next-page-token" }),
      );
    });

    test("incremental sync with old checkpoint (no lastRawUpdatedAt) applies 14-hour safety buffer", async () => {
      server.use(enhancedSearchHandler([{ issues: [], nextPageToken: null }]));

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: { lastSyncedAt: "2024-01-10T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      // 2024-01-10T00:00Z minus 14 hours = 2024-01-09T10:00Z
      expect(enhancedSearchBodies[0].jql).toContain(
        'updated >= "2024/01/09 10:00"',
      );
    });

    test("incremental sync with lastRawUpdatedAt uses local date extraction", async () => {
      server.use(enhancedSearchHandler([{ issues: [], nextPageToken: null }]));

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
      expect(enhancedSearchBodies[0].jql).toContain(
        'updated >= "2024/06/20 11:30"',
      );
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

      server.use(enhancedSearchHandler([{ issues, nextPageToken: null }]));

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

      server.use(
        enhancedSearchHandler([{ issues: [issue], nextPageToken: null }]),
      );

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
      server.use(
        enhancedSearchHandler([
          { issues: [makeIssue("PROJ-1", "Test issue")], nextPageToken: null },
        ]),
      );

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
      server.use(
        enhancedSearchHandler([
          { issues: [makeIssue("PROJ-1", "Test issue")], nextPageToken: null },
        ]),
      );

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
      expect(metadata.reporterEmail).toBe("reporter@example.com");
      expect(metadata.assignee).toBe("Assignee");
      expect(metadata.assigneeEmail).toBe("assignee@example.com");
      expect(metadata.issueType).toBe("Task");
      expect(metadata.project).toBe("PROJ");
      expect(metadata.projectName).toBe("Project");
      expect(metadata.resolution).toBe("Done");
      expect(metadata.resolutionDate).toBe("2024-01-20");
      expect(metadata.parent).toBe("PROJ-0");
      expect(metadata.created).toBe("2024-01-01");
      expect(metadata.updated).toBe("2024-01-15");
      expect(metadata.dueDate).toBe("2024-02-01");
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

      server.use(enhancedSearchHandler([{ issues, nextPageToken: null }]));

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
      server.use(enhancedSearchHandler([{ issues: [], nextPageToken: null }]));

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

      // Second sync: an issue was updated at 12:05 (after last issue's 12:00 timestamp)
      const updatedIssue = {
        ...makeIssue("PROJ-1", "Issue 1 - updated"),
        fields: {
          ...makeIssue("PROJ-1", "Issue 1 - updated").fields,
          updated: "2024-06-20T12:05:00.000Z",
        },
      };

      server.use(
        enhancedSearchHandler([
          { issues: firstSyncIssues, nextPageToken: null },
          { issues: [updatedIssue], nextPageToken: null },
        ]),
      );

      const firstBatches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        firstBatches.push(batch);
      }

      const savedCheckpoint = firstBatches[0].checkpoint;

      const secondBatches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: savedCheckpoint,
      })) {
        secondBatches.push(batch);
      }

      // The JQL should use the last issue's updated timestamp
      expect(enhancedSearchBodies[1].jql).toContain(
        'updated >= "2024/06/20 12:00"',
      );

      // Should find the updated issue
      expect(secondBatches[0].documents).toHaveLength(1);
      expect(secondBatches[0].documents[0].title).toBe("Issue 1 - updated");
    });

    test("throws on search API error", async () => {
      server.use(enhancedSearchErrorHandler(400));

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
      server.use(
        v2SearchHandler([
          {
            issues: [makeIssue("SRV-1", "Server issue")],
            startAt: 0,
            maxResults: 50,
            total: 1,
          },
        ]),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: serverConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(v2SearchBodies).toHaveLength(1);
      expect(enhancedSearchBodies).toHaveLength(0);
      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("SRV-1");
    });

    test("uses offset-based pagination with startAt", async () => {
      const page1Issues = Array.from({ length: 50 }, (_, i) =>
        makeIssue(`SRV-${i + 1}`, `Issue ${i + 1}`),
      );
      const page2Issues = [makeIssue("SRV-51", "Issue 51")];

      server.use(
        v2SearchHandler([
          {
            issues: page1Issues,
            startAt: 0,
            maxResults: 50,
            total: 51,
          },
          {
            issues: page2Issues,
            startAt: 50,
            maxResults: 50,
            total: 51,
          },
        ]),
      );

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
      expect(v2SearchBodies).toHaveLength(2);
      expect(v2SearchBodies[1]).toEqual(
        expect.objectContaining({ startAt: 50, maxResults: 50 }),
      );
    });

    test("stops when fewer results than BATCH_SIZE returned", async () => {
      server.use(
        v2SearchHandler([
          {
            issues: [makeIssue("SRV-1", "Only issue")],
            startAt: 0,
            maxResults: 50,
            total: 1,
          },
        ]),
      );

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
      expect(v2SearchBodies).toHaveLength(1);
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

      // Both configs normalize to the same host, so one handler serves both
      // syncs (each consumes one queued response).
      server.use(
        enhancedSearchHandler(
          [
            { issues: [makeIssue("PROJ-1")], nextPageToken: null },
            { issues: [makeIssue("PROJ-1")], nextPageToken: null },
          ],
          COMPANY_HOST,
        ),
      );

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
