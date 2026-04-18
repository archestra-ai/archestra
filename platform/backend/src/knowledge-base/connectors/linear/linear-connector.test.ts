import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { LinearConnector } from "./linear-connector";

const credentials = { apiToken: "lin_api_test" };

// ===== Mock @linear/sdk =====
const mockRawRequest = vi.fn();
let mockViewerResult: Promise<{ id?: string } | undefined> = Promise.resolve({
  id: "user-1",
});

vi.mock("@linear/sdk", () => {
  class MockLinearClient {
    get viewer() {
      return mockViewerResult;
    }
    client = { rawRequest: (...args: unknown[]) => mockRawRequest(...args) };
  }
  return { LinearClient: MockLinearClient };
});

describe("LinearConnector", () => {
  beforeEach(() => {
    mockRawRequest.mockReset();
    mockViewerResult = Promise.resolve({ id: "user-1" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      mockViewerResult = Promise.resolve({ id: "user-1" });

      const c = new LinearConnector();
      const r = await c.testConnection({ config: {}, credentials });
      expect(r.success).toBe(true);
    });

    test("returns error on GraphQL errors", async () => {
      mockViewerResult = Promise.reject(new Error("Invalid token"));

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
      mockRawRequest.mockResolvedValueOnce({
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
      });

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

      // Verify the rawRequest call included correct filter variables
      const variables = mockRawRequest.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      const filter = variables.filter as Record<string, unknown>;
      expect((filter.team as Record<string, unknown>).id).toEqual({
        in: ["team-a"],
      });
      expect((filter.state as Record<string, unknown>).name).toEqual({
        in: ["In Progress"],
      });
    });

    test("reuses issueUpdatedAfter when resuming pagination", async () => {
      mockRawRequest
        .mockResolvedValueOnce({
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
        })
        .mockResolvedValueOnce({
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
        });

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
      const secondVariables = mockRawRequest.mock.calls[1][1] as Record<
        string,
        unknown
      >;
      const secondFilter = secondVariables.filter as Record<string, unknown>;
      expect((secondFilter.updatedAt as Record<string, unknown>).gt).toBe(
        "2026-01-01T00:00:00.000Z",
      );
      expect(secondVariables.after).toBe("cur-1");
    });

    test("runs projects after issues when includeProjects is true", async () => {
      mockRawRequest
        .mockResolvedValueOnce({
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
        })
        .mockResolvedValueOnce({
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
        });

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
