import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { ConnectorSyncBatch } from "@/types";
import { GitlabConnector } from "./gitlab-connector";

// Wire-level (MSW) mocking: the real @gitbeaker/rest client runs and only the
// HTTP boundary is faked. gitbeaker uses global fetch, which MSW intercepts.
// The client is created with `camelize` disabled (the default), so wire
// responses stay snake_case exactly as the GitLab REST API returns them.
const GL = "https://gitlab.com";

const mockProject = {
  id: 42,
  name: "my-project",
  path_with_namespace: "my-group/my-project",
  web_url: "https://gitlab.com/my-group/my-project",
};

describe("GitlabConnector", () => {
  const server = useMswServer();
  let connector: GitlabConnector;

  // Captured wire traffic, reset per test.
  const userRequests: URL[] = [];
  const issuesRequests: URL[] = [];
  const mrRequests: URL[] = [];
  const projectsAllRequests: URL[] = [];
  const groupProjectsRequests: URL[] = [];
  const treeRequests: URL[] = [];
  const fileRequests: string[] = [];

  function userHandler(status?: number) {
    return http.get(`${GL}/api/v4/user`, ({ request }) => {
      userRequests.push(new URL(request.url));
      if (status) {
        return HttpResponse.json({ message: "401 Unauthorized" }, { status });
      }
      return HttpResponse.json({ id: 1, username: "test-user" });
    });
  }

  function projectShowHandler(project: unknown = mockProject) {
    return http.get(`${GL}/api/v4/projects/42`, () =>
      HttpResponse.json(project as Record<string, unknown>),
    );
  }

  function projectsAllHandler(projects: unknown[]) {
    return http.get(`${GL}/api/v4/projects`, ({ request }) => {
      projectsAllRequests.push(new URL(request.url));
      return HttpResponse.json(projects);
    });
  }

  function groupProjectsHandler(projects: unknown[], groupId = "my-group") {
    return http.get(
      `${GL}/api/v4/groups/${groupId}/projects`,
      ({ request }) => {
        groupProjectsRequests.push(new URL(request.url));
        return HttpResponse.json(projects);
      },
    );
  }

  function issuesHandler(pages: unknown[][]) {
    let call = 0;
    return http.get(`${GL}/api/v4/projects/42/issues`, ({ request }) => {
      issuesRequests.push(new URL(request.url));
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return HttpResponse.json(page);
    });
  }

  function issuesErrorHandler(status: number) {
    return http.get(`${GL}/api/v4/projects/42/issues`, () =>
      HttpResponse.json({ message: "Request failed" }, { status }),
    );
  }

  function mergeRequestsHandler(pages: unknown[][]) {
    let call = 0;
    return http.get(
      `${GL}/api/v4/projects/42/merge_requests`,
      ({ request }) => {
        mrRequests.push(new URL(request.url));
        const page = pages[Math.min(call, pages.length - 1)];
        call += 1;
        return HttpResponse.json(page);
      },
    );
  }

  function issueNotesHandler(config?: {
    notes?: Record<number, unknown[]>;
    errors?: Record<number, { status: number; message: string }>;
  }) {
    return http.get(
      `${GL}/api/v4/projects/42/issues/:iid/notes`,
      ({ params }) => {
        const iid = Number(params.iid);
        const err = config?.errors?.[iid];
        if (err) {
          return HttpResponse.json(
            { message: err.message },
            { status: err.status },
          );
        }
        return HttpResponse.json(config?.notes?.[iid] ?? []);
      },
    );
  }

  function mrNotesHandler(config?: {
    notes?: Record<number, unknown[]>;
    errors?: Record<number, { status: number; message: string }>;
  }) {
    return http.get(
      `${GL}/api/v4/projects/42/merge_requests/:iid/notes`,
      ({ params }) => {
        const iid = Number(params.iid);
        const err = config?.errors?.[iid];
        if (err) {
          return HttpResponse.json(
            { message: err.message },
            { status: err.status },
          );
        }
        return HttpResponse.json(config?.notes?.[iid] ?? []);
      },
    );
  }

  function treeHandler(items: unknown[]) {
    return http.get(
      `${GL}/api/v4/projects/42/repository/tree`,
      ({ request }) => {
        treeRequests.push(new URL(request.url));
        return HttpResponse.json(items);
      },
    );
  }

  function fileHandler(config: {
    contents?: Record<string, string>;
    errors?: Record<string, number>;
  }) {
    return http.get(
      // The client URL-encodes the file path (slashes become %2F), so it is a
      // single path segment here; MSW decodes the captured param.
      `${GL}/api/v4/projects/42/repository/files/:filePath`,
      ({ params }) => {
        const filePath = String(params.filePath);
        fileRequests.push(filePath);
        const errStatus = config.errors?.[filePath];
        if (errStatus) {
          return HttpResponse.json(
            { message: "file error" },
            { status: errStatus },
          );
        }
        return HttpResponse.json({
          content: Buffer.from(config.contents?.[filePath] ?? "").toString(
            "base64",
          ),
        });
      },
    );
  }

  const validConfig = {
    gitlabUrl: "https://gitlab.com",
    projectIds: [42],
  };

  const credentials = {
    apiToken: "glpat-test-token-123",
  };

  beforeEach(() => {
    userRequests.length = 0;
    issuesRequests.length = 0;
    mrRequests.length = 0;
    projectsAllRequests.length = 0;
    groupProjectsRequests.length = 0;
    treeRequests.length = 0;
    fileRequests.length = 0;
    connector = new GitlabConnector();
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

    test("returns invalid when gitlabUrl uses unsupported protocol", async () => {
      const result = await connector.validateConfig({
        gitlabUrl: "ftp://gitlab.example.com",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("valid HTTP(S) URL");
    });

    test("accepts URL without protocol by prepending https://", async () => {
      const result = await connector.validateConfig({
        gitlabUrl: "gitlab.com",
      });
      expect(result).toEqual({ valid: true });
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
      server.use(userHandler());

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(userRequests).toHaveLength(1);
    });

    test("returns error when API throws", async () => {
      server.use(userHandler(401));

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
      server.use(projectShowHandler());
    });

    test("yields batch of documents from issues", async () => {
      const issues = [
        makeIssue(1, "First issue"),
        makeIssue(2, "Second issue"),
      ];

      server.use(
        issuesHandler([issues]),
        issueNotesHandler(),
        mergeRequestsHandler([[]]),
      );

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
      const mrs = [
        makeMergeRequest(10, "Feature branch"),
        makeMergeRequest(11, "Bug fix"),
      ];

      server.use(
        issuesHandler([[]]),
        mergeRequestsHandler([mrs]),
        mrNotesHandler(),
      );

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
      server.use(
        issuesHandler([[makeIssue(1, "Issue with notes")]]),
        issueNotesHandler({
          notes: {
            1: [
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
            ],
          },
        }),
        mergeRequestsHandler([[]]),
      );

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

      server.use(
        issuesHandler([page1Issues, page2Issues]),
        issueNotesHandler(),
        mergeRequestsHandler([[]]),
      );

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
      server.use(issuesHandler([[]]), mergeRequestsHandler([[]]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: { lastSyncedAt: "2024-01-10T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      expect(issuesRequests[0].searchParams.get("updated_after")).toBe(
        "2024-01-10T00:00:00.000Z",
      );
    });

    test("skips items with labels in labelsToSkip", async () => {
      const issues = [
        makeIssue(1, "Keep this"),
        makeIssue(2, "Skip this", { labels: ["wontfix"] }),
      ];

      server.use(
        issuesHandler([issues]),
        issueNotesHandler(),
        mergeRequestsHandler([[]]),
      );

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
      server.use(
        mergeRequestsHandler([[makeMergeRequest(1, "A MR")]]),
        mrNotesHandler(),
      );

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
      expect(issuesRequests).toHaveLength(0);
    });

    test("respects includeMergeRequests=false", async () => {
      server.use(
        issuesHandler([[makeIssue(1, "An issue")]]),
        issueNotesHandler(),
      );

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
      expect(mrRequests).toHaveLength(0);
    });

    test("builds source URL correctly for issues", async () => {
      server.use(
        issuesHandler([[makeIssue(5, "Test issue")]]),
        issueNotesHandler(),
        mergeRequestsHandler([[]]),
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
        "https://gitlab.com/my-group/my-project/-/issues/5",
      );
    });

    test("includes metadata in documents", async () => {
      server.use(
        issuesHandler([
          [makeIssue(1, "Test issue", { labels: ["bug", "urgent"] })],
        ]),
        issueNotesHandler(),
        mergeRequestsHandler([[]]),
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
      expect(metadata.project).toBe("my-group/my-project");
      expect(metadata.iid).toBe(1);
      expect(metadata.state).toBe("opened");
      expect(metadata.kind).toBe("issue");
      expect(metadata.labels).toEqual(["bug", "urgent"]);
      expect(metadata.author).toBe("author");
    });

    test("continues sync when issue note fetch fails", async () => {
      const issues = [
        makeIssue(1, "First issue"),
        makeIssue(2, "Second issue"),
        makeIssue(3, "Third issue"),
      ];

      server.use(
        issuesHandler([issues]),
        issueNotesHandler({
          // 502 is a gitbeaker retry status; serve the message via a
          // non-retry status so the failure surfaces immediately with the
          // expected error string.
          errors: { 2: { status: 500, message: "502 Bad Gateway" } },
        }),
        mergeRequestsHandler([[]]),
      );

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
      expect(batches[0].documents[1].content).not.toContain("## Comments");

      // Failures array should contain 1 entry
      expect(batches[0].failures).toHaveLength(1);
      expect(batches[0].failures?.[0]).toEqual({
        itemId: 2,
        resource: "notes",
        error: "502 Bad Gateway",
      });
    });

    test("continues sync when MR note fetch fails", async () => {
      const mrs = [
        makeMergeRequest(10, "Feature branch"),
        makeMergeRequest(11, "Bug fix"),
      ];

      server.use(
        issuesHandler([[]]),
        mergeRequestsHandler([mrs]),
        mrNotesHandler({
          errors: { 10: { status: 500, message: "500 Internal Server Error" } },
        }),
      );

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

      // Failures in MR batch
      expect(mrBatch?.failures).toHaveLength(1);
      expect(mrBatch?.failures?.[0]).toEqual({
        itemId: 10,
        resource: "notes",
        error: "500 Internal Server Error",
      });
    });

    test("throws on API error", async () => {
      server.use(issuesErrorHandler(403));

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

      server.use(
        groupProjectsHandler([mockProject]),
        issuesHandler([[]]),
        mergeRequestsHandler([[]]),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: configWithGroup,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(groupProjectsRequests).toHaveLength(1);
      expect(groupProjectsRequests[0].pathname).toBe(
        "/api/v4/groups/my-group/projects",
      );
      expect(groupProjectsRequests[0].searchParams.get("per_page")).toBe("100");
    });

    test("fetches member projects when no filter specified", async () => {
      const configNoFilter = {
        gitlabUrl: "https://gitlab.com",
      };

      server.use(
        projectsAllHandler([mockProject]),
        issuesHandler([[]]),
        mergeRequestsHandler([[]]),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: configNoFilter,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(projectsAllRequests).toHaveLength(1);
      expect(projectsAllRequests[0].searchParams.get("membership")).toBe(
        "true",
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

      server.use(
        issuesHandler([issues]),
        issueNotesHandler(),
        mergeRequestsHandler([[]]),
      );

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
      server.use(issuesHandler([[]]), mergeRequestsHandler([[]]));

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

  describe("markdown file sync", () => {
    beforeEach(() => {
      server.use(projectShowHandler());
    });

    test("fetches and indexes markdown files when includeMarkdownFiles is true", async () => {
      server.use(
        issuesHandler([[]]),
        mergeRequestsHandler([[]]),
        treeHandler([
          { type: "blob", path: "README.md" },
          { type: "blob", path: "docs/guide.mdx" },
          { type: "blob", path: "src/index.ts" },
          { type: "tree", path: "docs" },
        ]),
        fileHandler({
          contents: {
            "README.md": "# README\nHello world",
            "docs/guide.mdx": "# Guide\nSome guide content",
          },
        }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeMarkdownFiles: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const mdDocs = batches
        .flatMap((b) => b.documents)
        .filter((d) => d.metadata.kind === "markdown_file");

      expect(mdDocs).toHaveLength(2);
      expect(mdDocs[0].id).toBe("my-group/my-project#file:README.md");
      expect(mdDocs[0].title).toBe("README.md (my-group/my-project)");
      expect(mdDocs[0].content).toBe("# README\nHello world");
      expect(mdDocs[0].sourceUrl).toContain("/-/blob/HEAD/README.md");
      expect(mdDocs[0].metadata.filePath).toBe("README.md");

      expect(mdDocs[1].id).toBe("my-group/my-project#file:docs/guide.mdx");
      expect(mdDocs[1].content).toBe("# Guide\nSome guide content");
    });

    test("does not fetch markdown files when includeMarkdownFiles is not set", async () => {
      server.use(issuesHandler([[]]), mergeRequestsHandler([[]]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(treeRequests).toHaveLength(0);
      expect(fileRequests).toHaveLength(0);
    });

    test("continues when file content fetch fails", async () => {
      server.use(
        issuesHandler([[]]),
        mergeRequestsHandler([[]]),
        treeHandler([
          { type: "blob", path: "a.md" },
          { type: "blob", path: "b.md" },
        ]),
        fileHandler({
          contents: { "b.md": "# B file" },
          errors: { "a.md": 403 },
        }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeMarkdownFiles: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const mdBatch = batches.find((b) =>
        b.documents.some((d) => d.metadata.kind === "markdown_file"),
      );
      expect(mdBatch).toBeDefined();
      expect(mdBatch?.documents).toHaveLength(1);
      expect(mdBatch?.documents[0].content).toBe("# B file");
      expect(mdBatch?.failures).toHaveLength(1);
      expect(mdBatch?.failures?.[0].itemId).toBe("a.md");
    });

    test("handles empty repo tree gracefully", async () => {
      server.use(
        issuesHandler([[]]),
        mergeRequestsHandler([[]]),
        treeHandler([]),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeMarkdownFiles: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Should complete without errors
      expect(batches.length).toBeGreaterThan(0);
      const lastBatch = batches[batches.length - 1];
      expect(lastBatch.hasMore).toBe(false);
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

  describe("permission sync", () => {
    const GROUP_ID = "gitlab.com//my-group/my-project";
    const CONTAINER_KEY = "project:my-group/my-project";

    function membersAllHandler(
      rosters: Record<number, unknown[] | { status: number }>,
    ) {
      return http.get(
        `${GL}/api/v4/projects/:projectId/members/all`,
        ({ params }) => {
          const roster = rosters[Number(params.projectId)];
          if (!roster) return HttpResponse.json([]);
          if (!Array.isArray(roster)) {
            return HttpResponse.json(
              { message: "error" },
              { status: roster.status },
            );
          }
          return HttpResponse.json(roster);
        },
      );
    }

    function usersShowHandler(profiles: Record<number, unknown>) {
      return http.get(`${GL}/api/v4/users/:userId`, ({ params }) => {
        const profile = profiles[Number(params.userId)];
        if (!profile) {
          return HttpResponse.json(
            { message: "404 Not Found" },
            { status: 404 },
          );
        }
        return HttpResponse.json(profile as Record<string, unknown>);
      });
    }

    /** readIngestedDocuments stub over a fixed per-project corpus. */
    function readbackOf(docsByProject: Record<string, string[]>) {
      const calls: Array<Record<string, string> | undefined> = [];
      const readIngestedDocuments = async (args: {
        metadataFilter?: Record<string, string>;
        afterId?: string | null;
        limit: number;
      }) => {
        calls.push(args.metadataFilter);
        const sourceIds =
          docsByProject[args.metadataFilter?.project ?? ""] ?? [];
        return {
          documents: sourceIds.map((sourceId) => ({
            sourceId,
            metadata: null,
          })),
          nextAfterId: null,
        };
      };
      return { readIngestedDocuments, calls };
    }

    async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
      const out: T[] = [];
      for await (const item of gen) out.push(item);
      return out;
    }

    // Pins the metadata-field contract with content-sync: every document kind
    // writes `metadata.project` = path_with_namespace, which is the container
    // key's id part.
    test("scopeKeyForDocument maps metadata.project to the container key", () => {
      expect(
        connector.scopeKeyForDocument({ project: "my-group/my-project" }),
      ).toBe(CONTAINER_KEY);
      expect(connector.scopeKeyForDocument({})).toBeNull();
      expect(connector.scopeKeyForDocument({ project: "" })).toBeNull();
      expect(connector.scopeKeyForDocument({ project: 42 })).toBeNull();
    });

    test("snapshot yields sorted containers with the roster-group audience and read-back document assignments", async () => {
      const projectB = {
        id: 43,
        name: "beta",
        path_with_namespace: "my-group/beta",
        web_url: `${GL}/my-group/beta`,
        visibility: "public",
      };
      server.use(
        projectShowHandler({ ...mockProject, visibility: "private" }),
        http.get(`${GL}/api/v4/projects/43`, () => HttpResponse.json(projectB)),
      );
      const { readIngestedDocuments, calls } = readbackOf({
        "my-group/my-project": ["my-group/my-project#issue-1"],
        "my-group/beta": ["my-group/beta#mr-2", "my-group/beta#file:README.md"],
      });

      const yields = await collect(
        connector.syncPermissionSnapshot({
          config: { ...validConfig, projectIds: [42, 43] },
          credentials,
          cursor: null,
          readIngestedDocuments,
        }),
      );

      // beta sorts before my-project; each container precedes its documents
      // and every yield's cursor is the current container key.
      expect(yields).toEqual([
        {
          kind: "container",
          containerKey: "project:my-group/beta",
          permissions: {
            isPublic: true,
            users: [],
            groups: ["gitlab.com//my-group/beta"],
          },
          audienceResolutionFailed: false,
          cursor: "project:my-group/beta",
        },
        {
          kind: "document",
          sourceId: "my-group/beta#mr-2",
          containerKey: "project:my-group/beta",
          cursor: "project:my-group/beta",
        },
        {
          kind: "document",
          sourceId: "my-group/beta#file:README.md",
          containerKey: "project:my-group/beta",
          cursor: "project:my-group/beta",
        },
        {
          kind: "container",
          containerKey: CONTAINER_KEY,
          permissions: { isPublic: false, users: [], groups: [GROUP_ID] },
          audienceResolutionFailed: false,
          cursor: CONTAINER_KEY,
        },
        {
          kind: "document",
          sourceId: "my-group/my-project#issue-1",
          containerKey: CONTAINER_KEY,
          cursor: CONTAINER_KEY,
        },
      ]);
      expect(calls).toEqual([
        { project: "my-group/beta" },
        { project: "my-group/my-project" },
      ]);
    });

    test("internal visibility is org-public; missing visibility fail-closes to private", async () => {
      server.use(
        projectShowHandler({ ...mockProject, visibility: "internal" }),
      );
      const { readIngestedDocuments } = readbackOf({});
      const [container] = await collect(
        connector.syncPermissionSnapshot({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments,
        }),
      );
      expect(container).toMatchObject({
        kind: "container",
        permissions: { isPublic: true },
      });

      server.use(projectShowHandler(mockProject)); // no visibility field
      const [failClosed] = await collect(
        connector.syncPermissionSnapshot({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments,
        }),
      );
      expect(failClosed).toMatchObject({
        kind: "container",
        permissions: { isPublic: false },
      });
    });

    test("resume cursor skips completed containers; scope restricts enumeration", async () => {
      const projectB = {
        id: 43,
        name: "beta",
        path_with_namespace: "my-group/beta",
        web_url: `${GL}/my-group/beta`,
        visibility: "private",
      };
      server.use(
        projectShowHandler({ ...mockProject, visibility: "private" }),
        http.get(`${GL}/api/v4/projects/43`, () => HttpResponse.json(projectB)),
      );
      const { readIngestedDocuments } = readbackOf({});

      const resumed = await collect(
        connector.syncPermissionSnapshot({
          config: { ...validConfig, projectIds: [42, 43] },
          credentials,
          cursor: CONTAINER_KEY,
          readIngestedDocuments,
        }),
      );
      // beta < the cursor key, so only the cursor container re-enumerates.
      expect(resumed.map((y) => y.containerKey)).toEqual([CONTAINER_KEY]);

      const scoped = await collect(
        connector.syncPermissionSnapshot({
          config: { ...validConfig, projectIds: [42, 43] },
          credentials,
          cursor: null,
          readIngestedDocuments,
          scope: { containerKeys: ["project:my-group/beta"] },
        }),
      );
      expect(scoped.map((y) => y.containerKey)).toEqual([
        "project:my-group/beta",
      ]);
    });

    test("syncGroups rosters Reporter+ active members with resolved emails", async () => {
      server.use(
        projectShowHandler({ ...mockProject, visibility: "private" }),
        membersAllHandler({
          42: [
            // Guest: below Reporter, excluded (cannot read ingested content).
            {
              id: 1,
              username: "guest",
              name: "Guest",
              access_level: 10,
              state: "active",
            },
            // Blocked: cannot sign in upstream, excluded.
            {
              id: 2,
              username: "blocked-dev",
              name: "Blocked",
              access_level: 30,
              state: "blocked",
            },
            // Email already on the member row (admin/enterprise case): no
            // profile request needed.
            {
              id: 3,
              username: "alice",
              name: "Alice",
              access_level: 30,
              state: "active",
              email: "alice@example.com",
            },
            // Email resolved from the public profile.
            {
              id: 4,
              username: "bob",
              name: "Bob",
              access_level: 20,
              state: "active",
            },
            // No public email anywhere: recorded with email null.
            {
              id: 5,
              username: "carol",
              name: "Carol",
              access_level: 50,
              state: "active",
            },
            // Project access-token bot account.
            {
              id: 6,
              username: "project_bot_abc123",
              name: "Token bot",
              access_level: 40,
              state: "active",
            },
          ],
        }),
        usersShowHandler({
          4: {
            id: 4,
            username: "bob",
            name: "Bob",
            public_email: "bob@example.com",
          },
          5: { id: 5, username: "carol", name: "Carol", public_email: "" },
          6: {
            id: 6,
            username: "project_bot_abc123",
            name: "Token bot",
            bot: true,
          },
        }),
      );

      const groups = await collect(
        connector.syncGroups({
          config: validConfig,
          credentials,
          cursor: null,
          readIngestedDocuments: readbackOf({}).readIngestedDocuments,
        }),
      );

      expect(groups).toEqual([
        {
          groupId: GROUP_ID,
          name: "my-group/my-project members",
          members: [
            {
              accountId: "alice",
              displayName: "Alice",
              email: "alice@example.com",
              accountType: null,
            },
            {
              accountId: "bob",
              displayName: "Bob",
              email: "bob@example.com",
              accountType: null,
            },
            {
              accountId: "carol",
              displayName: "Carol",
              email: null,
              accountType: null,
            },
            {
              accountId: "project_bot_abc123",
              displayName: "Token bot",
              email: null,
              accountType: "bot",
            },
          ],
          cursor: GROUP_ID,
        },
      ]);
    });

    test("an unreadable member list yields a fail-closed roster and the pass continues", async () => {
      const projectB = {
        id: 43,
        name: "beta",
        path_with_namespace: "my-group/beta",
        web_url: `${GL}/my-group/beta`,
        visibility: "private",
      };
      server.use(
        projectShowHandler({ ...mockProject, visibility: "private" }),
        http.get(`${GL}/api/v4/projects/43`, () => HttpResponse.json(projectB)),
        membersAllHandler({
          43: { status: 500 },
          42: [
            {
              id: 3,
              username: "alice",
              name: "Alice",
              access_level: 30,
              state: "active",
              email: "alice@example.com",
            },
          ],
        }),
      );

      const groups = await collect(
        connector.syncGroups({
          config: { ...validConfig, projectIds: [42, 43] },
          credentials,
          cursor: null,
          readIngestedDocuments: readbackOf({}).readIngestedDocuments,
        }),
      );

      expect(groups).toEqual([
        {
          groupId: "gitlab.com//my-group/beta",
          name: "my-group/beta members",
          members: [],
          membershipResolutionFailed: true,
          cursor: "gitlab.com//my-group/beta",
        },
        {
          groupId: GROUP_ID,
          name: "my-group/my-project members",
          members: [
            {
              accountId: "alice",
              displayName: "Alice",
              email: "alice@example.com",
              accountType: null,
            },
          ],
          cursor: GROUP_ID,
        },
      ]);
    });

    // Group tokens are namespaced by connector TYPE only, so the id must stay
    // globally distinctive across self-hosted instances: the instance host
    // (with port and any relative-URL subpath) leads the id.
    test("group ids embed the instance host so self-hosted instances never collide", async () => {
      const HOST = "https://gitlab.example.com:8443";
      server.use(
        http.get(`${HOST}/api/v4/projects/42`, () =>
          HttpResponse.json({ ...mockProject, visibility: "private" }),
        ),
        http.get(`${HOST}/api/v4/projects/:projectId/members/all`, () =>
          HttpResponse.json([]),
        ),
      );
      const config = { gitlabUrl: `${HOST}/`, projectIds: [42] };

      const [container] = await collect(
        connector.syncPermissionSnapshot({
          config,
          credentials,
          cursor: null,
          readIngestedDocuments: readbackOf({}).readIngestedDocuments,
        }),
      );
      const groups = await collect(
        connector.syncGroups({
          config,
          credentials,
          cursor: null,
          readIngestedDocuments: readbackOf({}).readIngestedDocuments,
        }),
      );

      const expectedId = "gitlab.example.com:8443//my-group/my-project";
      expect(container).toMatchObject({
        kind: "container",
        permissions: { groups: [expectedId] },
      });
      expect(groups[0].groupId).toBe(expectedId);
    });
  });
});
