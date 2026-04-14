import { afterEach, describe, expect, test, vi } from "@/test";
import type { ConnectorSyncBatch } from "@/types";
import { LinearConnector } from "./linear-connector";

const credentials = { apiToken: "lin_api_test" };

function mockJsonResponse(payload: {
  data?: unknown;
  errors?: Array<{ message: string }>;
}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("LinearConnector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("exposes type linear", () => {
    expect(new LinearConnector().type).toBe("linear");
  });

  describe("validateConfig", () => {
    test("accepts config with defaults", async () => {
      const c = new LinearConnector();
      const r = await c.validateConfig({});
      expect(r).toEqual({ valid: true });
    });

    test("rejects non-HTTP URL", async () => {
      const c = new LinearConnector();
      const r = await c.validateConfig({
        linearApiUrl: "ftp://example.com",
      });
      expect(r.valid).toBe(false);
      expect(r.error).toContain("valid HTTP(S) URL");
    });
  });

  describe("testConnection", () => {
    test("returns success when viewer resolves", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse({
          data: { viewer: { id: "user-1" } },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const c = new LinearConnector();
      const r = await c.testConnection({ config: {}, credentials });
      expect(r.success).toBe(true);
    });

    test("returns error on GraphQL errors", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse({
          errors: [{ message: "Invalid token" }],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const c = new LinearConnector();
      const r = await c.testConnection({ config: {}, credentials });
      expect(r.success).toBe(false);
      expect(r.error).toContain("Invalid token");
    });
  });

  describe("estimateTotalItems", () => {
    test("returns null when Linear count is unavailable", async () => {
      const c = new LinearConnector();
      const n = await c.estimateTotalItems({
        config: { teamIds: ["t1"] },
        credentials,
        checkpoint: null,
      });
      expect(n).toBeNull();
    });
  });

  describe("sync", () => {
    test("maps issues and applies team filter", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse({
          data: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "issue-1",
                  identifier: "ENG-1",
                  title: "Hello",
                  description: "Desc",
                  url: "https://linear.app/i/1",
                  updatedAt: "2026-01-02T12:00:00.000Z",
                  state: { name: "In Progress" },
                  team: { key: "ENG", name: "Engineering" },
                  project: { id: "proj-1", name: "Mobile" },
                  labels: { nodes: [{ name: "bug" }] },
                  comments: {
                    nodes: [
                      {
                        body: "Nice",
                        createdAt: "2026-01-02T13:00:00.000Z",
                        user: { name: "Sam" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const connector = new LinearConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const b of connector.sync({
        config: { teamIds: ["team-a"], states: ["In Progress"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(b);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("issue-1");
      expect(batches[0].documents[0].title).toBe("ENG-1: Hello");
      expect(batches[0].documents[0].content).toContain("## Comments");
      expect(batches[0].documents[0].content).toContain("Sam");
      expect(batches[0].documents[0].content).toContain("Project: Mobile");
      expect(
        (batches[0].checkpoint as { lastRawUpdatedAt?: string })
          .lastRawUpdatedAt,
      ).toBe("2026-01-02T12:00:00.000Z");
      expect(batches[0].hasMore).toBe(false);

      const body = JSON.parse(
        String((fetchMock.mock.calls[0][1] as RequestInit | undefined)?.body),
      );
      expect(body.variables.filter.team.id.in).toEqual(["team-a"]);
      expect(body.variables.filter.state.name.in).toEqual(["In Progress"]);
    });

    test("reuses issueUpdatedAfter when resuming pagination", async () => {
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce(
          mockJsonResponse({
            data: {
              issues: {
                pageInfo: { hasNextPage: true, endCursor: "cur-1" },
                nodes: [
                  {
                    id: "i1",
                    identifier: "A-1",
                    title: "One",
                    description: "",
                    url: "https://linear.app/i/1",
                    updatedAt: "2026-01-03T00:00:00.000Z",
                    state: { name: "Todo" },
                    team: { key: "A", name: "A" },
                    project: null,
                    labels: { nodes: [] },
                    comments: { nodes: [] },
                  },
                ],
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          mockJsonResponse({
            data: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "i2",
                    identifier: "A-2",
                    title: "Two",
                    description: "",
                    url: "https://linear.app/i/2",
                    updatedAt: "2026-01-03T01:00:00.000Z",
                    state: { name: "Todo" },
                    team: { key: "A", name: "A" },
                    project: null,
                    labels: { nodes: [] },
                    comments: { nodes: [] },
                  },
                ],
              },
            },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const connector = new LinearConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const b of connector.sync({
        config: {},
        credentials,
        checkpoint: {
          type: "linear",
          issuePageCursor: "cur-0",
          issueUpdatedAfter: "2026-01-01T00:00:00.000Z",
        },
      })) {
        batches.push(b);
      }

      expect(batches).toHaveLength(2);
      const second = JSON.parse(
        String((fetchMock.mock.calls[1][1] as RequestInit | undefined)?.body),
      );
      expect(second.variables.filter.updatedAt.gt).toBe(
        "2026-01-01T00:00:00.000Z",
      );
      expect(second.variables.after).toBe("cur-1");
    });

    test("runs projects after issues when includeProjects is true", async () => {
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce(
          mockJsonResponse({
            data: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "i1",
                    identifier: "X-1",
                    title: "Issue",
                    description: "",
                    url: "https://linear.app/i/1",
                    updatedAt: "2026-01-04T00:00:00.000Z",
                    state: { name: "Done" },
                    team: { key: "X", name: "X" },
                    project: null,
                    labels: { nodes: [] },
                    comments: { nodes: [] },
                  },
                ],
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          mockJsonResponse({
            data: {
              projects: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "p1",
                    name: "Roadmap",
                    description: "D",
                    content: "C",
                    url: "https://linear.app/p/1",
                    updatedAt: "2026-01-04T01:00:00.000Z",
                    state: "started",
                    projectUpdates: { nodes: [] },
                  },
                ],
              },
            },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const connector = new LinearConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const b of connector.sync({
        config: { includeProjects: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(b);
      }

      expect(batches.length).toBeGreaterThanOrEqual(2);
      expect(batches[0].documents[0].metadata.kind).toBe("issue");
      expect(batches[1].documents[0].id).toBe("linear-project-p1");
      expect(batches[0].hasMore).toBe(true);
      expect(batches[batches.length - 1].hasMore).toBe(false);
    });
  });
});
