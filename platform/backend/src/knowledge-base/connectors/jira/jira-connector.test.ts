import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { ConnectorSyncBatch, PermissionSnapshotYield } from "@/types";
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

  describe("estimateTotalItems", () => {
    test("uses the approximate-count endpoint on Cloud", async () => {
      // Cloud removed the classic totals-bearing JQL search; estimating via
      // it fails every run, which silently strips totals from all progress
      // display. The approximate-count endpoint is the replacement.
      let requestedJql: string | undefined;
      server.use(
        http.post(
          `${CLOUD_HOST}/rest/api/3/search/approximate-count`,
          async ({ request }) => {
            requestedJql = ((await request.json()) as { jql?: string }).jql;
            return HttpResponse.json({ count: 22917 });
          },
        ),
      );

      const total = await connector.estimateTotalItems({
        config: validConfig,
        credentials,
        checkpoint: null,
      });

      expect(total).toBe(22917);
      expect(requestedJql).toContain("project =");
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

  describe("scopeKeyForDocument", () => {
    // Pins the metadata-field contract with content-sync: documents are
    // written with `project` = the Jira project key, and the delta pass's
    // local-adoption scoping depends on reading exactly that field.
    test("maps content-sync document metadata to the project scope key", () => {
      expect(
        connector.scopeKeyForDocument({ project: "ENG", issueKey: "ENG-1" }),
      ).toBe("project:ENG");
    });

    test("returns null when the metadata cannot place the document", () => {
      expect(connector.scopeKeyForDocument({})).toBeNull();
      expect(connector.scopeKeyForDocument({ project: "" })).toBeNull();
      expect(connector.scopeKeyForDocument({ project: 42 })).toBeNull();
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

  describe("permission sync", () => {
    async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
      const out: T[] = [];
      for await (const item of gen) out.push(item);
      return out;
    }

    /** Collect a permission snapshot into containers + document assignments. */
    async function collectSnapshot(
      gen: AsyncGenerator<PermissionSnapshotYield> | undefined,
    ) {
      const containers = new Map<string, unknown>();
      /** The whole container yield, for assertions beyond its audience. */
      const containerYields = new Map<
        string,
        Extract<PermissionSnapshotYield, { kind: "container" }>
      >();
      const documents: Extract<
        PermissionSnapshotYield,
        { kind: "document" }
      >[] = [];
      for await (const item of gen ??
        ((async function* () {})() as AsyncGenerator<PermissionSnapshotYield>)) {
        if (item.kind === "container") {
          containers.set(item.containerKey, item.permissions);
          containerYields.set(item.containerKey, item);
        } else {
          documents.push(item);
        }
      }
      return { containers, containerYields, documents };
    }

    /** The audience of a single-document snapshot's one assignment. */
    function audienceOfOnly(
      snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
    ) {
      if (snapshot.documents.length !== 1) {
        throw new Error(
          `Expected exactly one assignment, got ${snapshot.documents.length}`,
        );
      }
      return snapshot.containers.get(snapshot.documents[0].containerKey);
    }

    /** The effective audience of one document: its container's permissions. */
    function audienceOf(
      snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
      sourceId: string,
    ) {
      const doc = snapshot.documents.find((d) => d.sourceId === sourceId);
      if (!doc) throw new Error(`No assignment yielded for ${sourceId}`);
      return snapshot.containers.get(doc.containerKey);
    }

    function searchHandler(issues: unknown[]) {
      return http.post(`${CLOUD_HOST}/rest/api/3/search/jql`, () =>
        HttpResponse.json({ issues, nextPageToken: undefined }),
      );
    }

    const syncParams = {
      config: validConfig,
      credentials,
      cursor: null,
      readIngestedDocuments: async () => ({
        documents: [],
        nextAfterId: null,
      }),
    };

    test("supportsPermissionSync is true", () => {
      expect(connector.supportsPermissionSync).toBe(true);
    });

    test("snapshot enumeration sends well-formed JQL (WHERE clauses before ORDER BY)", async () => {
      // Regression: the per-project clause was once appended AFTER buildJql's
      // `ORDER BY updated ASC` suffix — Jira 400s every snapshot request and
      // the pass can never enumerate a single document.
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.post(
          `${CLOUD_HOST}/rest/api/3/search/jql`,
          async ({ request }) => {
            bodies.push((await request.json()) as Record<string, unknown>);
            return HttpResponse.json({ issues: [], nextPageToken: undefined });
          },
        ),
      );

      await collectSnapshot(connector.syncPermissionSnapshot?.(syncParams));

      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body.jql).toBe('project = "PROJ" ORDER BY updated ASC');
      }
    });

    test("project BROWSE_PROJECTS grants: anyone → public, group → group id", async () => {
      server.use(
        searchHandler([
          {
            key: "PROJ-1",
            fields: { project: { key: "PROJ" }, security: null },
          },
        ]),
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({
            id: 10,
            permissions: [
              {
                permission: "BROWSE_PROJECTS",
                holder: { type: "group", value: "jira-users" },
              },
              { permission: "BROWSE_PROJECTS", holder: { type: "anyone" } },
            ],
          }),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(syncParams),
      );

      expect(snapshot.documents).toEqual([
        {
          kind: "document",
          sourceId: "PROJ-1",
          containerKey: "project:PROJ",
          cursor: "project:PROJ",
        },
      ]);
      expect(audienceOf(snapshot, "PROJ-1")).toEqual({
        isPublic: true,
        users: [],
        groups: ["jira-users"],
      });
    });

    test("an applicationRole grant resolves to the role's site-access groups, NOT org-wide", async () => {
      // "Any logged-in user" of the site is a specific, revocable set — the
      // application's access groups — not the whole Archestra org. Mapping it
      // to org:* would keep granting users removed from the site upstream.
      server.use(
        searchHandler([
          {
            key: "PROJ-7",
            fields: { project: { key: "PROJ" }, security: null },
          },
        ]),
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({
            id: 10,
            permissions: [
              {
                permission: "BROWSE_PROJECTS",
                holder: { type: "applicationRole", parameter: "jira-software" },
              },
            ],
          }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/applicationrole/jira-software`, () =>
          HttpResponse.json({
            key: "jira-software",
            groupDetails: [
              { name: "jira-users-site", groupId: "uuid-1" },
              { name: "jira-software-users", groupId: "uuid-2" },
            ],
          }),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(syncParams),
      );

      expect(audienceOfOnly(snapshot)).toEqual({
        isPublic: false,
        users: [],
        groups: ["jira-users-site", "jira-software-users"],
      });
    });

    test("an applicationRole grant with no key unions ALL application roles' groups", async () => {
      // An empty parameter means "any logged-in user" regardless of product.
      server.use(
        searchHandler([
          {
            key: "PROJ-8",
            fields: { project: { key: "PROJ" }, security: null },
          },
        ]),
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({
            id: 10,
            permissions: [
              {
                permission: "BROWSE_PROJECTS",
                holder: { type: "applicationRole" },
              },
            ],
          }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/applicationrole`, () =>
          HttpResponse.json([
            {
              key: "jira-software",
              groupDetails: [{ name: "jira-users-site" }],
            },
            // Legacy `groups` (names) used when groupDetails is absent.
            { key: "jira-core", groups: ["jira-core-users"] },
          ]),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(syncParams),
      );

      expect(audienceOfOnly(snapshot)).toEqual({
        isPublic: false,
        users: [],
        groups: ["jira-users-site", "jira-core-users"],
      });
    });

    test("an applicationRole grant fail-closes when the role lookup fails", async () => {
      server.use(
        searchHandler([
          {
            key: "PROJ-6",
            fields: { project: { key: "PROJ" }, security: null },
          },
        ]),
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({
            id: 10,
            permissions: [
              {
                permission: "BROWSE_PROJECTS",
                holder: { type: "applicationRole", parameter: "jira-software" },
              },
            ],
          }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/applicationrole/jira-software`, () =>
          HttpResponse.json({ errorMessages: ["forbidden"] }, { status: 500 }),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(syncParams),
      );

      // Under-grant, never over-grant: no org:*, no groups.
      expect(audienceOfOnly(snapshot)).toEqual({
        isPublic: false,
        users: [],
        groups: [],
      });
    });

    test("a permission scheme that yields no grants reports the container as unreadable, not as empty", async () => {
      // The scheme call succeeds but carries no `permissions`, and the by-id
      // fallback comes back empty too. The old code iterated `grants ?? []`,
      // resolved an empty audience, and said nothing — so every issue in the
      // project went dark and the run looked completely healthy. The empty
      // audience is still the right (fail-closed) answer; being silent about it
      // was not.
      server.use(
        searchHandler([
          {
            key: "PROJ-9",
            fields: { project: { key: "PROJ" }, security: null },
          },
        ]),
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({ id: 10 }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/permissionscheme/10`, () =>
          HttpResponse.json({ id: 10 }),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(syncParams),
      );

      const container = snapshot.containerYields.get("project:PROJ");
      expect(container?.permissions).toEqual({
        isPublic: false,
        users: [],
        groups: [],
      });
      expect(container?.audienceResolutionFailed).toBe(true);
    });

    test("a permission-scheme request that fails reports the container as unreadable", async () => {
      server.use(
        searchHandler([
          {
            key: "PROJ-10",
            fields: { project: { key: "PROJ" }, security: null },
          },
        ]),
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({ errorMessages: ["boom"] }, { status: 500 }),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(syncParams),
      );

      const container = snapshot.containerYields.get("project:PROJ");
      expect(container?.audienceResolutionFailed).toBe(true);
    });

    test("a resolvable scheme granting nobody is NOT reported as unreadable", async () => {
      // The counterpart the flag exists to distinguish: we read the scheme fine,
      // and it genuinely grants browse to nobody. Same empty audience, but
      // nothing is wrong and nothing should be flagged.
      server.use(
        searchHandler([
          {
            key: "PROJ-11",
            fields: { project: { key: "PROJ" }, security: null },
          },
        ]),
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({ id: 10, permissions: [] }),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(syncParams),
      );

      const container = snapshot.containerYields.get("project:PROJ");
      expect(container?.permissions).toEqual({
        isPublic: false,
        users: [],
        groups: [],
      });
      expect(container?.audienceResolutionFailed).toBe(false);
    });

    test("a Cloud group grant uses the group NAME (parameter), not the UUID (value)", async () => {
      // On Jira Cloud a group holder's `value` is the group UUID and
      // `parameter` is the name; syncGroups keys membership by NAME, so the
      // document token must be the name to byte-match — else group members are
      // silently denied.
      server.use(
        searchHandler([
          {
            key: "PROJ-9",
            fields: { project: { key: "PROJ" }, security: null },
          },
        ]),
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({
            id: 10,
            permissions: [
              {
                permission: "BROWSE_PROJECTS",
                holder: {
                  type: "group",
                  value: "5e8f1c2a-0000-0000-0000-abcdef012345",
                  parameter: "engineering",
                },
              },
            ],
          }),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(syncParams),
      );

      expect(audienceOfOnly(snapshot)).toEqual({
        isPublic: false,
        users: [],
        groups: ["engineering"],
      });
    });

    test("a user grant resolves to an email via getUser", async () => {
      server.use(
        searchHandler([
          { key: "PROJ-3", fields: { project: { key: "PROJ" } } },
        ]),
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({
            id: 10,
            permissions: [
              {
                permission: "BROWSE_PROJECTS",
                holder: { type: "user", value: "acc-1" },
              },
            ],
          }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/user`, () =>
          HttpResponse.json({ emailAddress: "bob@example.com" }),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(syncParams),
      );

      expect(audienceOfOnly(snapshot)).toEqual({
        isPublic: false,
        users: ["bob@example.com"],
        groups: [],
      });
    });

    test("an issue security level overrides the project browse audience", async () => {
      server.use(
        searchHandler([
          {
            key: "PROJ-2",
            fields: { project: { key: "PROJ" }, security: { id: "100" } },
          },
        ]),
        http.get(
          `${CLOUD_HOST}/rest/api/3/project/PROJ/issuesecuritylevelscheme`,
          () => HttpResponse.json({ id: 20 }),
        ),
        http.get(
          `${CLOUD_HOST}/rest/api/3/issuesecurityschemes/20/members`,
          () =>
            HttpResponse.json({
              values: [
                {
                  issueSecurityLevelId: "100",
                  holder: { type: "group", value: "secret-team" },
                },
              ],
              total: 1,
            }),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(syncParams),
      );

      expect(audienceOfOnly(snapshot)).toEqual({
        isPublic: false,
        users: [],
        groups: ["secret-team"],
      });
    });

    test("syncGroups expands groups to members, keeping hidden-email members with email null", async () => {
      server.use(
        http.get(`${CLOUD_HOST}/rest/api/3/group/bulk`, () =>
          HttpResponse.json({ values: [{ name: "devs" }], total: 1 }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/group/member`, () =>
          HttpResponse.json({
            values: [
              {
                accountId: "acc-alice",
                displayName: "Alice",
                emailAddress: "alice@example.com",
              },
              // Email hidden by Atlassian profile visibility — the member must
              // still be recorded (fail-closed), not silently dropped.
              { accountId: "acc-bob", displayName: "Bob" },
              // Add-on/bot account — classification must travel with the
              // member so admin stats can separate it from hidden humans.
              {
                accountId: "acc-bot",
                displayName: "Automation for Jira",
                accountType: "app",
              },
            ],
            total: 3,
          }),
        ),
      );

      const yields = await collect(
        connector.syncGroups?.(syncParams) ?? (async function* () {})(),
      );

      expect(yields).toEqual([
        {
          groupId: "devs",
          members: [
            {
              accountId: "acc-alice",
              displayName: "Alice",
              email: "alice@example.com",
              accountType: null,
            },
            {
              accountId: "acc-bob",
              displayName: "Bob",
              email: null,
              accountType: null,
            },
            {
              accountId: "acc-bot",
              displayName: "Automation for Jira",
              email: null,
              accountType: "app",
            },
          ],
          cursor: "devs",
        },
      ]);
    });

    test("syncGroups keeps paginating members when the API omits total", async () => {
      // Regression: `total ?? startAt` made the break condition always true
      // on a missing `total`, silently truncating a group to its first page.
      // Enumeration must instead run until an empty page.
      server.use(
        http.get(`${CLOUD_HOST}/rest/api/3/group/bulk`, () =>
          HttpResponse.json({ values: [{ name: "devs" }], total: 1 }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/group/member`, ({ request }) => {
          const startAt = Number(
            new URL(request.url).searchParams.get("startAt") ?? "0",
          );
          const pages: Record<number, unknown[]> = {
            0: [{ accountId: "acc-alice", displayName: "Alice" }],
            1: [{ accountId: "acc-bob", displayName: "Bob" }],
          };
          return HttpResponse.json({ values: pages[startAt] ?? [] });
        }),
      );

      const yields = await collect(
        connector.syncGroups?.(syncParams) ?? (async function* () {})(),
      );

      expect(yields).toHaveLength(1);
      expect(yields[0].members.map((m) => m.accountId)).toEqual([
        "acc-alice",
        "acc-bob",
      ]);
    });

    test("syncGroups resolves hidden emails through the Atlassian admin directory when the credential is an org-admin API key", async () => {
      // The product API hides most emails (profile visibility, AX-207); an
      // org-admin API key credential unlocks the Organizations directory,
      // which returns managed accounts' emails regardless of visibility.
      server.use(
        http.get(`${CLOUD_HOST}/rest/api/3/group/bulk`, () =>
          HttpResponse.json({ values: [{ name: "devs" }], total: 1 }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/group/member`, () =>
          HttpResponse.json({
            values: [{ accountId: "acc-bob", displayName: "Bob" }],
            total: 1,
          }),
        ),
        http.get("https://api.atlassian.com/admin/v1/orgs", () =>
          HttpResponse.json({ data: [{ id: "org-1" }], links: {} }),
        ),
        http.get(
          "https://api.atlassian.com/admin/v2/orgs/org-1/directories",
          () =>
            HttpResponse.json({ data: [{ directoryId: "dir-1" }], links: {} }),
        ),
        http.post(
          "https://api.atlassian.com/admin/v2/orgs/org-1/directories/dir-1/users/search",
          () =>
            HttpResponse.json({
              data: [{ accountId: "acc-bob", email: "bob@example.com" }],
              links: {},
            }),
        ),
      );

      const yields = await collect(
        connector.syncGroups?.(syncParams) ?? (async function* () {})(),
      );

      expect(yields[0].members).toEqual([
        {
          accountId: "acc-bob",
          displayName: "Bob",
          email: "bob@example.com",
          accountType: null,
        },
      ]);
    });

    test("syncGroups prefers the dedicated admin API key as the admin-API bearer", async () => {
      // The product apiToken and the org-admin API key are different
      // Atlassian credential kinds (each API family rejects the other), so
      // when a dedicated key is configured the admin APIs must be called
      // with it — not with the product token.
      let adminAuthHeader: string | null = null;
      server.use(
        http.get(`${CLOUD_HOST}/rest/api/3/group/bulk`, () =>
          HttpResponse.json({ values: [{ name: "devs" }], total: 1 }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/group/member`, () =>
          HttpResponse.json({
            values: [{ accountId: "acc-bob", displayName: "Bob" }],
            total: 1,
          }),
        ),
        http.get("https://api.atlassian.com/admin/v1/orgs", ({ request }) => {
          adminAuthHeader = request.headers.get("authorization");
          return HttpResponse.json({ data: [{ id: "org-1" }], links: {} });
        }),
        http.get(
          "https://api.atlassian.com/admin/v2/orgs/org-1/directories",
          () =>
            HttpResponse.json({ data: [{ directoryId: "dir-1" }], links: {} }),
        ),
        http.post(
          "https://api.atlassian.com/admin/v2/orgs/org-1/directories/dir-1/users/search",
          () =>
            HttpResponse.json({
              data: [{ accountId: "acc-bob", email: "bob@example.com" }],
              links: {},
            }),
        ),
      );

      const yields = await collect(
        connector.syncGroups?.({
          ...syncParams,
          credentials: { ...credentials, adminApiKey: "org-admin-key" },
        }) ?? (async function* () {})(),
      );

      expect(adminAuthHeader).toBe("Bearer org-admin-key");
      expect(yields[0].members[0].email).toBe("bob@example.com");
    });

    test("syncGroups uses groupId for the member lookup and keeps NAME as the token key", async () => {
      // The member lookup must go by immutable groupId (some names 404), but
      // the yielded groupId — the token / snapshot key — must stay the NAME to
      // byte-match document group tokens.
      let memberQuery: URLSearchParams | undefined;
      server.use(
        http.get(`${CLOUD_HOST}/rest/api/3/group/bulk`, () =>
          HttpResponse.json({
            values: [{ name: "devs", groupId: "uuid-123" }],
            total: 1,
          }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/group/member`, ({ request }) => {
          memberQuery = new URL(request.url).searchParams;
          return HttpResponse.json({
            values: [{ emailAddress: "alice@example.com" }],
            total: 1,
          });
        }),
      );

      const yields = await collect(
        connector.syncGroups?.(syncParams) ?? (async function* () {})(),
      );

      expect(memberQuery?.get("groupId")).toBe("uuid-123");
      expect(memberQuery?.get("groupname")).toBeNull();
      expect(yields[0].groupId).toBe("devs");
    });

    test("syncGroups skips a group whose member lookup fails instead of aborting the enumeration", async () => {
      // Hidden system groups (`atlassian-addons`) are listed by group/bulk but
      // 404 on member lookup; one bad group must not leave the whole snapshot
      // empty (which silently fail-closes every group grant).
      server.use(
        http.get(`${CLOUD_HOST}/rest/api/3/group/bulk`, () =>
          HttpResponse.json({
            values: [{ name: "atlassian-addons" }, { name: "devs" }],
            total: 2,
          }),
        ),
        http.get(`${CLOUD_HOST}/rest/api/3/group/member`, ({ request }) => {
          const groupname = new URL(request.url).searchParams.get("groupname");
          if (groupname === "atlassian-addons") {
            return HttpResponse.json(
              {
                errorMessages: [
                  "The group named 'atlassian-addons' does not exist",
                ],
              },
              { status: 404 },
            );
          }
          return HttpResponse.json({
            values: [{ emailAddress: "alice@example.com" }],
            total: 1,
          });
        }),
      );

      const yields = await collect(
        connector.syncGroups?.(syncParams) ?? (async function* () {})(),
      );

      // The failed group yields empty (fail-closed for it alone); the healthy
      // group is still enumerated.
      expect(yields).toEqual([
        {
          groupId: "atlassian-addons",
          members: [],
          cursor: "atlassian-addons",
        },
        {
          groupId: "devs",
          members: [
            {
              accountId: "alice@example.com",
              displayName: null,
              email: "alice@example.com",
              accountType: null,
            },
          ],
          cursor: "devs",
        },
      ]);
    });

    test("probePermissionChanges: first probe demands a full pass; the JQL window maps drift to projects", async () => {
      // First probe (no state) → fullRequired, cursor established.
      const first = await connector.probePermissionChanges?.({
        config: validConfig,
        credentials,
        state: null,
      });
      expect(first?.fullRequired).toBe(true);
      expect(typeof first?.nextState.jqlCursor).toBe("string");

      // Cursored probe: two changed issues in different projects. NO audit
      // endpoint handler is installed — the probe must not call it (audit
      // inference was removed: a revocation ingested minutes late slid out
      // of the cursor window, and its wording matched no grant keyword;
      // audiences/memberships are verified directly every delta pass).
      let probeJql: unknown;
      server.use(
        http.post(
          `${CLOUD_HOST}/rest/api/3/search/jql`,
          async ({ request }) => {
            probeJql = ((await request.json()) as Record<string, unknown>).jql;
            return HttpResponse.json({
              issues: [{ key: "PROJ-3" }, { key: "OTHER-9" }],
              nextPageToken: undefined,
            });
          },
        ),
      );
      const probe = await connector.probePermissionChanges?.({
        config: validConfig,
        credentials,
        state: { jqlCursor: "2026-07-01T00:00:00.000Z" },
      });
      expect(probe?.dirtyContainerKeys).toEqual([
        "project:OTHER",
        "project:PROJ",
      ]);
      expect(probe?.fullRequired).toBe(false);
      expect(typeof probe?.nextState.jqlCursor).toBe("string");
      // Well-formed JQL: the cursor clause sits BEFORE the ORDER BY suffix
      // (string-appending it after once made Jira 400 every probe).
      expect(probeJql).toBe(
        'project = "PROJ" AND updated >= "2026/06/30 10:00" ORDER BY updated ASC',
      );
    });

    test("refreshContainerAudiences re-resolves stored audiences with ZERO issue enumeration", async () => {
      // No search handler is installed: if the refresh touched the issue
      // search API, MSW would fail the test as an unhandled request.
      server.use(
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({
            id: 10,
            permissions: [
              {
                permission: "BROWSE_PROJECTS",
                holder: { type: "group", value: "jira-users" },
              },
            ],
          }),
        ),
      );

      const out: unknown[] = [];
      const generator = connector.refreshContainerAudiences?.({
        config: validConfig,
        credentials,
        containerKeys: ["project:PROJ", "not-a-container-shape"],
      });
      if (!generator) throw new Error("hook missing");
      for await (const item of generator) out.push(item);

      // The unknown-shaped key is skipped (left for the full backstop), the
      // project audience is re-resolved from the scheme grants.
      expect(out).toEqual([
        {
          containerKey: "project:PROJ",
          permissions: { isPublic: false, users: [], groups: ["jira-users"] },
          audienceResolutionFailed: false,
        },
      ]);
    });

    test("a directly-granted account with a hidden upstream email materializes as its mapped user's email", async () => {
      server.use(
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/permissionscheme`, () =>
          HttpResponse.json({
            id: 10,
            permissions: [
              {
                permission: "BROWSE_PROJECTS",
                holder: { type: "projectRole", value: "10001" },
              },
            ],
          }),
        ),
        // The role actor's upstream email is hidden — no user-lookup handler
        // is needed because the admin mapping resolves FIRST, without a call.
        http.get(`${CLOUD_HOST}/rest/api/3/project/PROJ/role/10001`, () =>
          HttpResponse.json({
            actors: [{ actorUser: { accountId: "acc-hidden" } }],
          }),
        ),
      );

      const out: { permissions: { users: string[] } }[] = [];
      const generator = connector.refreshContainerAudiences?.({
        config: validConfig,
        credentials,
        containerKeys: ["project:PROJ"],
        resolveMappedEmail: (externalAccountId) =>
          externalAccountId === "acc-hidden" ? "mapped@example.com" : null,
      });
      if (!generator) throw new Error("hook missing");
      for await (const item of generator) {
        out.push(item as { permissions: { users: string[] } });
      }

      expect(out).toHaveLength(1);
      expect(out[0].permissions.users).toEqual(["mapped@example.com"]);
    });

    test("server (isCloud=false) resolves issue audiences through the v2 API, paging by startAt", async () => {
      const serverParams = {
        ...syncParams,
        config: {
          jiraBaseUrl: SERVER_HOST,
          isCloud: false,
          projectKey: "PROJ",
        },
      };
      server.use(
        v2SearchHandler([
          {
            issues: [
              {
                key: "PROJ-1",
                fields: { project: { key: "PROJ" }, security: null },
              },
            ],
            total: 1,
          },
        ]),
        http.get(
          `${SERVER_HOST}/rest/api/2/project/PROJ/permissionscheme`,
          () =>
            HttpResponse.json({
              id: 10,
              permissions: [
                {
                  permission: "BROWSE_PROJECTS",
                  holder: { type: "group", value: "jira-users" },
                },
              ],
            }),
        ),
      );

      const snapshot = await collectSnapshot(
        connector.syncPermissionSnapshot?.(serverParams),
      );

      expect(snapshot.documents).toEqual([
        {
          kind: "document",
          sourceId: "PROJ-1",
          containerKey: "project:PROJ",
          cursor: "project:PROJ",
        },
      ]);
      expect(audienceOf(snapshot, "PROJ-1")).toEqual({
        isPublic: false,
        users: [],
        groups: ["jira-users"],
      });
      expect(v2SearchBodies[0]).toMatchObject({ startAt: 0 });
    });
  });
});
