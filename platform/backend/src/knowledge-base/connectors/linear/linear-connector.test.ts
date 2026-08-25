import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ConnectorSyncBatch,
  GroupMembershipYield,
  PermissionSnapshotYield,
  PermissionSyncParams,
} from "@/types";
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

// ===== Helpers =====

/** Collect all batches from a sync generator. */
async function collectBatches(
  gen: AsyncGenerator<ConnectorSyncBatch>,
): Promise<ConnectorSyncBatch[]> {
  const batches: ConnectorSyncBatch[] = [];
  for await (const b of gen) batches.push(b);
  return batches;
}

/** Pull the `filter.updatedAt.gt` value out of the Nth rawRequest call. */
function captureUpdatedAfter(callIndex: number): string | undefined {
  const variables = mockRawRequest.mock.calls[callIndex]?.[1] as
    | Record<string, unknown>
    | undefined;
  const filter = variables?.filter as Record<string, unknown> | undefined;
  return (filter?.updatedAt as { gt?: string } | undefined)?.gt;
}

/** Build a minimal issue node for mock responses. */
function makeIssueNode(id: string, updatedAt: string) {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Title ${id}`,
    description: "",
    url: `https://linear.app/i/${id}`,
    updatedAt,
    state: { name: "Todo" },
    team: { key: "ENG", name: "Engineering" },
    project: null,
    labels: { nodes: [] },
    comments: { nodes: [] },
  };
}

/** Build a minimal project node for mock responses. */
function makeProjectNode(id: string, updatedAt: string) {
  return {
    id,
    name: `Project ${id}`,
    description: "",
    content: "",
    url: `https://linear.app/p/${id}`,
    updatedAt,
    state: "started",
    projectUpdates: { nodes: [] },
  };
}

/** Build a minimal cycle node for mock responses. */
function makeCycleNode(id: string, updatedAt: string) {
  return {
    id,
    name: `Cycle ${id}`,
    description: "",
    number: 1,
    updatedAt,
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2026-01-15T00:00:00.000Z",
    completedAt: null,
    isActive: true,
    team: { key: "ENG", name: "Engineering" },
  };
}

/** Wrap nodes in the shape rawRequest returns for issues. */
function issuesResponse(
  nodes: ReturnType<typeof makeIssueNode>[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      issues: { pageInfo: { hasNextPage, endCursor }, nodes },
    },
  };
}

/** Wrap nodes in the shape rawRequest returns for projects. */
function projectsResponse(
  nodes: ReturnType<typeof makeProjectNode>[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      projects: { pageInfo: { hasNextPage, endCursor }, nodes },
    },
  };
}

/** Wrap nodes in the shape rawRequest returns for cycles. */
function cyclesResponse(
  nodes: ReturnType<typeof makeCycleNode>[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      cycles: { pageInfo: { hasNextPage, endCursor }, nodes },
    },
  };
}

// ===== Tests =====

describe("LinearConnector", () => {
  beforeEach(() => {
    mockRawRequest.mockReset();
    mockViewerResult = Promise.resolve({ id: "user-1" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    // -------------------------------------------------------------------------
    // Incremental sync: lower-bound correctness across phases
    // -------------------------------------------------------------------------

    describe("incremental sync: lower-bound correctness across phases", () => {
      /**
       * Scenario timeline
       * -----------------
       * T1 = "2026-01-10T00:00:00.000Z"  ← lastSyncedAt / watermarks from previous run
       * T2 = "2026-01-12T00:00:00.000Z"  ← a project updated AFTER T1 but BEFORE T3
       * T3 = "2026-01-15T00:00:00.000Z"  ← newest issue seen in current run
       *                                       (issues phase advances lastSyncedAt to T3)
       * T4 = "2026-01-11T00:00:00.000Z"  ← a cycle updated AFTER T1 but BEFORE T3
       *
       * Bug: if projects/cycles derive their lower bound from the live
       * cp.lastSyncedAt (which becomes T3 after the issues phase), they send
       * filter.updatedAt > T3 and miss the items at T2 and T4.
       *
       * Fix: each phase uses the lastSyncedAt captured at the START of the run
       * (T1), so the filter is > T1 – safety_buffer, which includes T2 and T4.
       */
      const T1 = "2026-01-10T00:00:00.000Z"; // previous sync watermark
      const T2 = "2026-01-12T00:00:00.000Z"; // project update in the gap
      const T3 = "2026-01-15T00:00:00.000Z"; // newest issue in current run
      const T4 = "2026-01-11T00:00:00.000Z"; // cycle update in the gap

      // The safety buffer is 5 minutes; T1 minus buffer is the expected gt value.
      const T1_minus_buffer = new Date(
        new Date(T1).getTime() - 5 * 60 * 1000,
      ).toISOString();

      test("full run: issues → projects → cycles all emit correct documents", async () => {
        mockRawRequest
          .mockResolvedValueOnce(
            // issues phase: one issue at T3
            issuesResponse([makeIssueNode("i1", T3)]),
          )
          .mockResolvedValueOnce(
            // projects phase: one project at T2 (in the gap)
            projectsResponse([makeProjectNode("p1", T2)]),
          )
          .mockResolvedValueOnce(
            // cycles phase: one cycle at T4 (in the gap)
            cyclesResponse([makeCycleNode("c1", T4)]),
          );

        const checkpoint = {
          type: "linear",
          lastSyncedAt: T1,
          lastRawUpdatedAt: T1,
          projectLastRawUpdatedAt: T1,
          cycleLastRawUpdatedAt: T1,
          linearSyncPhase: "issues",
        };

        const connector = new LinearConnector();
        const batches = await collectBatches(
          connector.sync({
            config: {
              includeProjects: true,
              includeCycles: true,
            },
            credentials,
            checkpoint,
          }),
        );

        // All three phases must have produced documents
        const allDocs = batches.flatMap((b) => b.documents);
        const docIds = allDocs.map((d) => d.id);
        expect(docIds).toContain("i1");
        expect(docIds).toContain("linear-project-p1");
        expect(docIds).toContain("linear-cycle-c1");

        // The final checkpoint must record the per-resource watermarks
        const finalCp = batches[batches.length - 1].checkpoint as Record<
          string,
          unknown
        >;
        expect(finalCp.lastRawUpdatedAt).toBe(T3);
        expect(finalCp.projectLastRawUpdatedAt).toBe(T2);
        expect(finalCp.cycleLastRawUpdatedAt).toBe(T4);

        // The final batch must signal no more work
        expect(batches[batches.length - 1].hasMore).toBe(false);
      });

      test("projects phase uses pre-run lastSyncedAt, not the value advanced by issues", async () => {
        // Issues advance lastSyncedAt to T3. The project at T2 must still be
        // included; that can only happen if the projects filter is anchored to
        // T1 (minus safety buffer), not to T3.
        mockRawRequest
          .mockResolvedValueOnce(issuesResponse([makeIssueNode("i1", T3)]))
          .mockResolvedValueOnce(projectsResponse([makeProjectNode("p1", T2)]));

        const checkpoint = {
          type: "linear",
          lastSyncedAt: T1,
          lastRawUpdatedAt: T1,
          linearSyncPhase: "issues",
        };

        const connector = new LinearConnector();
        await collectBatches(
          connector.sync({
            config: { includeProjects: true },
            credentials,
            checkpoint,
          }),
        );

        // Call 0 = issues, call 1 = projects
        const projectsUpdatedAfter = captureUpdatedAfter(1);

        // Must be anchored to T1 (minus buffer), NOT to T3 or later
        expect(projectsUpdatedAfter).toBeDefined();
        const safeProjectsUpdatedAfter = projectsUpdatedAfter as string;
        expect(
          new Date(safeProjectsUpdatedAfter).getTime(),
        ).toBeLessThanOrEqual(new Date(T1_minus_buffer).getTime());
        expect(new Date(safeProjectsUpdatedAfter).getTime()).toBeLessThan(
          new Date(T2).getTime(),
        );
      });

      test("cycles phase uses pre-run lastSyncedAt, not the value advanced by issues", async () => {
        mockRawRequest
          .mockResolvedValueOnce(issuesResponse([makeIssueNode("i1", T3)]))
          .mockResolvedValueOnce(cyclesResponse([makeCycleNode("c1", T4)]));

        const checkpoint = {
          type: "linear",
          lastSyncedAt: T1,
          lastRawUpdatedAt: T1,
          linearSyncPhase: "issues",
        };

        const connector = new LinearConnector();
        await collectBatches(
          connector.sync({
            config: { includeCycles: true },
            credentials,
            checkpoint,
          }),
        );

        // Call 0 = issues, call 1 = cycles
        const cyclesUpdatedAfter = captureUpdatedAfter(1);

        expect(cyclesUpdatedAfter).toBeDefined();
        const safeCyclesUpdatedAfter = cyclesUpdatedAfter as string;
        expect(new Date(safeCyclesUpdatedAfter).getTime()).toBeLessThanOrEqual(
          new Date(T1_minus_buffer).getTime(),
        );
        expect(new Date(safeCyclesUpdatedAfter).getTime()).toBeLessThan(
          new Date(T4).getTime(),
        );
      });

      test("projects phase uses its own watermark when one exists, not lastSyncedAt", async () => {
        // projectLastRawUpdatedAt = T2 (earlier than T3 but later than T1)
        // Even with the fix, the project-specific watermark must win over the
        // lastSyncedAt fallback.
        const projectWatermark = T2;

        mockRawRequest
          .mockResolvedValueOnce(issuesResponse([makeIssueNode("i1", T3)]))
          .mockResolvedValueOnce(projectsResponse([makeProjectNode("p1", T3)]));

        const checkpoint = {
          type: "linear",
          lastSyncedAt: T1,
          lastRawUpdatedAt: T1,
          projectLastRawUpdatedAt: projectWatermark,
          linearSyncPhase: "issues",
        };

        const connector = new LinearConnector();
        await collectBatches(
          connector.sync({
            config: { includeProjects: true },
            credentials,
            checkpoint,
          }),
        );

        const projectsUpdatedAfter = captureUpdatedAfter(1);
        // Must use the dedicated project watermark exactly, no buffer applied
        expect(projectsUpdatedAfter).toBe(projectWatermark);
      });

      test("cycles phase uses its own watermark when one exists", async () => {
        const cycleWatermark = T4;

        mockRawRequest
          .mockResolvedValueOnce(issuesResponse([makeIssueNode("i1", T3)]))
          .mockResolvedValueOnce(cyclesResponse([makeCycleNode("c1", T3)]));

        const checkpoint = {
          type: "linear",
          lastSyncedAt: T1,
          lastRawUpdatedAt: T1,
          cycleLastRawUpdatedAt: cycleWatermark,
          linearSyncPhase: "issues",
        };

        const connector = new LinearConnector();
        await collectBatches(
          connector.sync({
            config: { includeCycles: true },
            credentials,
            checkpoint,
          }),
        );

        const cyclesUpdatedAfter = captureUpdatedAfter(1);
        expect(cyclesUpdatedAfter).toBe(cycleWatermark);
      });
    });

    // -------------------------------------------------------------------------
    // Resume edge case: feature flags toggled after checkpoint written
    // -------------------------------------------------------------------------

    describe("resume edge case: feature flags toggled after checkpoint written", () => {
      test("cycles run when checkpoint is 'projects' but includeProjects is now false", async () => {
        // The previous run was mid-projects phase and wrote linearSyncPhase =
        // "projects". includeProjects has since been turned off. The connector
        // must skip straight to cycles without getting stuck.
        mockRawRequest.mockResolvedValueOnce(
          cyclesResponse([makeCycleNode("c1", "2026-01-20T00:00:00.000Z")]),
        );

        const checkpoint = {
          type: "linear",
          lastSyncedAt: "2026-01-10T00:00:00.000Z",
          linearSyncPhase: "projects",
        };

        const connector = new LinearConnector();
        const batches = await collectBatches(
          connector.sync({
            config: {
              includeProjects: false, // toggled off
              includeCycles: true,
            },
            credentials,
            checkpoint,
          }),
        );

        // Must have produced cycles, not been skipped
        const allDocs = batches.flatMap((b) => b.documents);
        expect(allDocs.length).toBeGreaterThan(0);
        expect(allDocs[0].id).toBe("linear-cycle-c1");

        // issues phase must NOT have run (no issues mock was registered)
        expect(mockRawRequest).toHaveBeenCalledTimes(1);

        // Final checkpoint must reset phase to "issues" (cycles complete)
        const finalCp = batches[batches.length - 1].checkpoint as Record<
          string,
          unknown
        >;
        expect(finalCp.linearSyncPhase).toBe("issues");
      });

      test("issues run when checkpoint is 'cycles' but includeCycles is now false", async () => {
        mockRawRequest.mockResolvedValueOnce(
          issuesResponse([makeIssueNode("i1", "2026-01-20T00:00:00.000Z")]),
        );

        const checkpoint = {
          type: "linear",
          lastSyncedAt: "2026-01-10T00:00:00.000Z",
          linearSyncPhase: "cycles",
        };

        const connector = new LinearConnector();
        const batches = await collectBatches(
          connector.sync({
            config: {
              includeProjects: false,
              includeCycles: false, // toggled off
            },
            credentials,
            checkpoint,
          }),
        );

        const allDocs = batches.flatMap((b) => b.documents);
        expect(allDocs.length).toBeGreaterThan(0);
        expect(allDocs[0].id).toBe("i1");
        expect(mockRawRequest).toHaveBeenCalledTimes(1);
      });

      test("projects run when checkpoint is 'projects' and includeProjects remains true", async () => {
        // Sanity check: feature flag unchanged, mid-projects resume must still
        // run projects (not skip to cycles).
        mockRawRequest.mockResolvedValueOnce(
          projectsResponse([makeProjectNode("p1", "2026-01-20T00:00:00.000Z")]),
        );

        const checkpoint = {
          type: "linear",
          lastSyncedAt: "2026-01-10T00:00:00.000Z",
          linearSyncPhase: "projects",
        };

        const connector = new LinearConnector();
        const batches = await collectBatches(
          connector.sync({
            config: { includeProjects: true, includeCycles: false },
            credentials,
            checkpoint,
          }),
        );

        const allDocs = batches.flatMap((b) => b.documents);
        expect(allDocs[0].id).toBe("linear-project-p1");
        expect(mockRawRequest).toHaveBeenCalledTimes(1);
      });
    });

    // -------------------------------------------------------------------------
    // Mid-page resume: per-resource cursor + lower-bound locked together
    // -------------------------------------------------------------------------

    describe("mid-page resume: cursor and lower-bound stay locked", () => {
      test("projects mid-page resume preserves cursor and lower-bound", async () => {
        // Simulate resuming a projects page: the checkpoint has both a cursor
        // and a projectUpdatedAfter. Both must be forwarded as-is.
        mockRawRequest.mockResolvedValueOnce(
          projectsResponse([makeProjectNode("p2", "2026-01-20T00:00:00.000Z")]),
        );

        const lockedAfter = "2026-01-08T00:00:00.000Z";
        const checkpoint = {
          type: "linear",
          lastSyncedAt: "2026-01-15T00:00:00.000Z",
          linearSyncPhase: "projects",
          projectPageCursor: "proj-cursor-42",
          projectUpdatedAfter: lockedAfter,
        };

        const connector = new LinearConnector();
        await collectBatches(
          connector.sync({
            config: { includeProjects: true },
            credentials,
            checkpoint,
          }),
        );

        const variables = mockRawRequest.mock.calls[0][1] as Record<
          string,
          unknown
        >;
        expect(variables.after).toBe("proj-cursor-42");
        expect(captureUpdatedAfter(0)).toBe(lockedAfter);
      });

      test("cycles mid-page resume preserves cursor and lower-bound", async () => {
        mockRawRequest.mockResolvedValueOnce(
          cyclesResponse([makeCycleNode("c2", "2026-01-20T00:00:00.000Z")]),
        );

        const lockedAfter = "2026-01-07T00:00:00.000Z";
        const checkpoint = {
          type: "linear",
          lastSyncedAt: "2026-01-15T00:00:00.000Z",
          linearSyncPhase: "cycles",
          cyclePageCursor: "cycle-cursor-7",
          cycleUpdatedAfter: lockedAfter,
        };

        const connector = new LinearConnector();
        await collectBatches(
          connector.sync({
            config: { includeCycles: true },
            credentials,
            checkpoint,
          }),
        );

        const variables = mockRawRequest.mock.calls[0][1] as Record<
          string,
          unknown
        >;
        expect(variables.after).toBe("cycle-cursor-7");
        expect(captureUpdatedAfter(0)).toBe(lockedAfter);
      });
    });
  });
});

// ===== Permission sync =====

describe("permission sync", () => {
  type ContainerYield = Extract<PermissionSnapshotYield, { kind: "container" }>;
  type DocumentYield = Extract<PermissionSnapshotYield, { kind: "document" }>;

  const ORG = { id: "org-uuid-1", name: "Acme" };
  const ENG = {
    id: "team-uuid-eng",
    key: "ENG",
    name: "Engineering",
    private: false,
  };
  const SEC = {
    id: "team-uuid-sec",
    key: "SEC",
    name: "Security",
    private: true,
  };

  const alice = {
    id: "u-alice",
    name: "Alice",
    email: "Alice@example.com",
    active: true,
    guest: false,
    app: false,
  };
  const bob = {
    id: "u-bob",
    name: "Bob",
    email: "bob@example.com",
    active: true,
    guest: true,
    app: false,
  };
  const carol = {
    id: "u-carol",
    name: "Carol",
    email: "carol@example.com",
    active: false,
    guest: false,
    app: false,
  };
  const botUser = {
    id: "u-bot",
    name: "Sync Bot",
    email: null,
    active: true,
    guest: false,
    app: true,
  };

  const permDocs = [
    { sourceId: "i1", metadata: { kind: "issue", teamKey: "ENG" } },
    { sourceId: "i2", metadata: { kind: "issue", teamKey: "ENG" } },
    { sourceId: "i3", metadata: { kind: "issue", teamKey: "SEC" } },
    {
      sourceId: "linear-cycle-c1",
      metadata: { kind: "cycle", teamKey: "ENG" },
    },
    {
      sourceId: "linear-project-p1",
      metadata: { kind: "project", projectId: "p1" },
    },
    // Ingested before the projectId stamp: id comes from the sourceId.
    { sourceId: "linear-project-p2", metadata: { kind: "project" } },
  ];

  function makePermReadBack(
    docs: Array<{ sourceId: string; metadata: Record<string, unknown> }>,
  ) {
    return vi.fn(
      async (args: {
        metadataFilter?: Record<string, string>;
        afterId?: string | null;
        limit: number;
      }) => {
        let rows = docs.filter(
          (doc) =>
            !args.metadataFilter ||
            Object.entries(args.metadataFilter).every(
              ([key, value]) => doc.metadata[key] === value,
            ),
        );
        rows = rows
          .filter((doc) => !args.afterId || doc.sourceId > args.afterId)
          .sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
        const page = rows.slice(0, args.limit);
        return {
          documents: page,
          nextAfterId: page.length ? page[page.length - 1].sourceId : null,
        };
      },
    );
  }

  /**
   * Route the raw GraphQL mock by operation name. Overridable per test via
   * the overrides map (operation substring -> implementation).
   */
  function stubPermissionApi(
    overrides: Partial<
      Record<string, (variables: Record<string, unknown>) => unknown>
    > = {},
  ) {
    mockRawRequest.mockImplementation(
      (query: unknown, variables: Record<string, unknown>) => {
        const q = String(query);
        for (const [needle, impl] of Object.entries(overrides)) {
          if (q.includes(needle)) return Promise.resolve(impl?.(variables));
        }
        if (q.includes("LinearPermissionOrganization")) {
          return Promise.resolve({ data: { organization: ORG } });
        }
        if (q.includes("LinearPermissionTeamMembers")) {
          const nodes =
            variables.teamId === ENG.id ? [alice, bob, carol] : [alice];
          return Promise.resolve({
            data: {
              team: {
                members: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes,
                },
              },
            },
          });
        }
        if (q.includes("LinearPermissionTeams")) {
          return Promise.resolve({
            data: {
              teams: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [ENG, SEC],
              },
            },
          });
        }
        if (q.includes("LinearPermissionUsers")) {
          return Promise.resolve({
            data: {
              users: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [alice, bob, carol, botUser],
              },
            },
          });
        }
        if (q.includes("LinearPermissionProjectAudiences")) {
          const filter = variables.filter as { id?: { in?: string[] } };
          const known = (filter.id?.in ?? []).includes("p1")
            ? [
                {
                  id: "p1",
                  teams: {
                    pageInfo: { hasNextPage: false },
                    nodes: [{ id: SEC.id }],
                  },
                  members: {
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        id: "u-eve",
                        email: "Eve@example.com",
                        active: true,
                        app: false,
                      },
                      { id: "u-bot", email: null, active: true, app: true },
                    ],
                  },
                },
              ]
            : [];
          return Promise.resolve({
            data: {
              projects: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: known,
              },
            },
          });
        }
        throw new Error(`Unexpected permission query: ${q.slice(0, 120)}`);
      },
    );
  }

  function syncParams(
    overrides: Partial<PermissionSyncParams> = {},
  ): PermissionSyncParams {
    return {
      config: { linearApiUrl: "https://api.linear.app" },
      credentials,
      cursor: null,
      readIngestedDocuments: makePermReadBack(permDocs),
      ...overrides,
    };
  }

  async function collectSnapshot(gen: AsyncGenerator<PermissionSnapshotYield>) {
    const containers = new Map<string, ContainerYield>();
    const documents: DocumentYield[] = [];
    const order: string[] = [];
    for await (const y of gen) {
      expect(y.cursor).toBe(y.containerKey);
      if (y.kind === "container") {
        containers.set(y.containerKey, y);
        order.push(y.containerKey);
      } else {
        documents.push(y);
      }
    }
    return { containers, documents, order };
  }

  beforeEach(() => {
    mockRawRequest.mockReset();
  });

  test("full snapshot: team and project containers, sorted, fail-closed for a vanished project", async () => {
    stubPermissionApi();
    const connector = new LinearConnector();
    const { containers, documents, order } = await collectSnapshot(
      connector.syncPermissionSnapshot(syncParams()),
    );

    expect(order).toEqual(["project:p1", "project:p2", "team:ENG", "team:SEC"]);

    // Public team: its own group plus the workspace-members group.
    expect(containers.get("team:ENG")?.permissions.groups?.sort()).toEqual([
      `team-${ENG.id}`,
      `workspace-members-${ORG.id}`,
    ]);
    // Private team: its roster only.
    expect(containers.get("team:SEC")?.permissions.groups).toEqual([
      `team-${SEC.id}`,
    ]);

    // Project on a private team: no workspace group; explicit project
    // members appear as direct (lowercased) user emails; app users dropped.
    const p1 = containers.get("project:p1");
    expect(p1?.permissions.groups).toEqual([`team-${SEC.id}`]);
    expect(p1?.permissions.users).toEqual(["eve@example.com"]);
    expect(p1?.audienceResolutionFailed).toBeUndefined();

    // Vanished project: empty audience, flagged, docs still assigned.
    const p2 = containers.get("project:p2");
    expect(p2?.permissions).toEqual({ users: [], groups: [] });
    expect(p2?.audienceResolutionFailed).toBe(true);

    const byContainer = new Map<string, string[]>();
    for (const doc of documents) {
      const list = byContainer.get(doc.containerKey) ?? [];
      list.push(doc.sourceId);
      byContainer.set(doc.containerKey, list);
    }
    expect(byContainer.get("team:ENG")?.sort()).toEqual([
      "i1",
      "i2",
      "linear-cycle-c1",
    ]);
    expect(byContainer.get("team:SEC")).toEqual(["i3"]);
    expect(byContainer.get("project:p1")).toEqual(["linear-project-p1"]);
    expect(byContainer.get("project:p2")).toEqual(["linear-project-p2"]);
  });

  test("resume cursor skips containers strictly below it", async () => {
    stubPermissionApi();
    const connector = new LinearConnector();
    const { order } = await collectSnapshot(
      connector.syncPermissionSnapshot(syncParams({ cursor: "team:ENG" })),
    );
    expect(order).toEqual(["team:ENG", "team:SEC"]);
  });

  test("delta scope enumerates only the requested containers", async () => {
    stubPermissionApi();
    const connector = new LinearConnector();
    const { order, documents } = await collectSnapshot(
      connector.syncPermissionSnapshot(
        syncParams({ scope: { containerKeys: ["team:SEC"] } }),
      ),
    );
    expect(order).toEqual(["team:SEC"]);
    expect(documents.map((d) => d.sourceId)).toEqual(["i3"]);
  });

  test("syncGroups: one group per team plus workspace members, sorted, rosters filtered", async () => {
    stubPermissionApi();
    const connector = new LinearConnector();
    const groups: GroupMembershipYield[] = [];
    for await (const g of connector.syncGroups(syncParams())) groups.push(g);

    expect(groups.map((g) => g.groupId)).toEqual([
      `team-${ENG.id}`,
      `team-${SEC.id}`,
      `workspace-members-${ORG.id}`,
    ]);

    const eng = groups[0];
    expect(eng.name).toBe("Engineering");
    // Suspended carol is dropped; guest bob stays with accountType "guest".
    expect(eng.members).toEqual([
      {
        accountId: "u-alice",
        displayName: "Alice",
        email: "alice@example.com",
        accountType: "member",
      },
      {
        accountId: "u-bob",
        displayName: "Bob",
        email: "bob@example.com",
        accountType: "guest",
      },
    ]);

    const workspace = groups[2];
    expect(workspace.name).toBe("Acme workspace members");
    // Guests never enter the workspace group; apps are rostered as "app".
    expect(workspace.members).toEqual([
      {
        accountId: "u-alice",
        displayName: "Alice",
        email: "alice@example.com",
        accountType: "member",
      },
      {
        accountId: "u-bot",
        displayName: "Sync Bot",
        email: null,
        accountType: "app",
      },
    ]);
  });

  test("syncGroups throws on a mid-pagination roster failure instead of truncating", async () => {
    let membersCall = 0;
    stubPermissionApi({
      LinearPermissionTeamMembers: () => {
        membersCall += 1;
        if (membersCall === 1) {
          return {
            data: {
              team: {
                members: {
                  pageInfo: { hasNextPage: true, endCursor: "page-2" },
                  nodes: [alice],
                },
              },
            },
          };
        }
        throw new Error("boom");
      },
    });
    const connector = new LinearConnector();
    const gen = connector.syncGroups(syncParams());
    await expect(async () => {
      for await (const _ of gen) {
        // drain
      }
    }).rejects.toThrow("boom");
  });

  test("scopeKeyForDocument maps kinds to their governing container", () => {
    const connector = new LinearConnector();
    expect(
      connector.scopeKeyForDocument({ kind: "issue", teamKey: "ENG" }),
    ).toBe("team:ENG");
    expect(
      connector.scopeKeyForDocument({ kind: "cycle", teamKey: "SEC" }),
    ).toBe("team:SEC");
    expect(
      connector.scopeKeyForDocument({ kind: "project", projectId: "p1" }),
    ).toBe("project:p1");
    expect(connector.scopeKeyForDocument({ kind: "project" })).toBeNull();
    expect(connector.scopeKeyForDocument({ kind: "issue" })).toBeNull();
    expect(connector.scopeKeyForDocument({ kind: "mystery" })).toBeNull();
  });
});
