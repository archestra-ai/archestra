import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types";
import { AsanaConnector, extractAsanaHtml } from "./asana-connector";

// Mock asana SDK
const mockGetUser = vi.fn();
const mockGetProject = vi.fn();
const mockGetProjectsForWorkspace = vi.fn();
const mockGetTasksForProject = vi.fn();
const mockGetStoriesForTask = vi.fn();

vi.mock("asana", () => ({
  ApiClient: class MockApiClient {
    authentications: Record<string, unknown> = {};
  },
  UsersApi: class MockUsersApi {
    getUser = mockGetUser;
  },
  ProjectsApi: class MockProjectsApi {
    getProject = mockGetProject;
    getProjectsForWorkspace = mockGetProjectsForWorkspace;
  },
  TasksApi: class MockTasksApi {
    getTasksForProject = mockGetTasksForProject;
  },
  StoriesApi: class MockStoriesApi {
    getStoriesForTask = mockGetStoriesForTask;
  },
}));

// Narrow view onto the protected `rateLimit` method inherited from
// BaseConnector — used by tests that spy on throttling calls without widening
// the type to `any`.
type RateLimitedConnector = { rateLimit: () => Promise<void> };

describe("AsanaConnector", () => {
  let connector: AsanaConnector;

  const validConfig = {
    workspaceGid: "1234567890",
    projectGids: ["111111"],
  };

  const credentials = {
    apiToken: "0/test-token-123",
  };

  // Shared task factory used across multiple describe blocks.
  function makeTask(
    gid: string,
    name: string,
    opts?: { tags?: string[]; notes?: string; modified_at?: string },
  ) {
    return {
      gid,
      name,
      notes: opts?.notes ?? `Notes for ${name}`,
      completed: false,
      modified_at: opts?.modified_at ?? "2024-01-15T10:00:00.000Z",
      created_at: "2024-01-10T10:00:00.000Z",
      permalink_url: `https://app.asana.com/0/111111/${gid}`,
      assignee: { name: "Test User" },
      projects: [{ name: "My Project" }],
      tags: (opts?.tags ?? []).map((t) => ({ name: t })),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new AsanaConnector();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("validateConfig", () => {
    test("returns valid for correct config", async () => {
      const result = await connector.validateConfig(validConfig);
      expect(result).toEqual({ valid: true });
    });

    test("returns invalid when workspaceGid is missing", async () => {
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.error).toContain("workspaceGid");
    });

    test("returns invalid when workspaceGid is empty", async () => {
      const result = await connector.validateConfig({
        workspaceGid: "",
      });
      expect(result.valid).toBe(false);
    });

    test("accepts config with optional projectGids", async () => {
      const result = await connector.validateConfig({
        workspaceGid: "1234567890",
        projectGids: ["111", "222"],
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts config with tagsToSkip", async () => {
      const result = await connector.validateConfig({
        workspaceGid: "1234567890",
        tagsToSkip: ["internal", "draft"],
      });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("testConnection", () => {
    test("returns success when API responds OK", async () => {
      mockGetUser.mockResolvedValueOnce({
        data: { gid: "123", name: "Test User" },
      });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockGetUser).toHaveBeenCalledWith("me", {});
    });

    test("returns error when API throws", async () => {
      mockGetUser.mockRejectedValueOnce(new Error("401 Unauthorized"));

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
      expect(result.error).toContain("Invalid Asana configuration");
    });
  });

  describe("sync", () => {
    const mockProject = {
      gid: "111111",
      name: "My Project",
      // Matches validConfig.workspaceGid so explicit projectGids pass
      // the workspace-scope validation.
      workspace: { gid: "1234567890" },
    };

    beforeEach(() => {
      mockGetProject.mockResolvedValue({
        data: mockProject,
      });
    });

    test("yields batch of documents from tasks", async () => {
      const tasks = [
        makeTask("t1", "First task"),
        makeTask("t2", "Second task"),
      ];

      mockGetTasksForProject.mockResolvedValueOnce({ data: tasks });
      mockGetStoriesForTask
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] });

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
      expect(batches[0].documents[0].id).toBe("task-t1");
      expect(batches[0].documents[0].title).toBe("First task");
      expect(batches[0].documents[1].id).toBe("task-t2");
    });

    test("multi-homed task is emitted once per sync (cross-project dedup)", async () => {
      // Same task gid appears under two selected projects. The connector must
      // emit it once — not rely on downstream KB upsert to swallow the second
      // copy — to avoid redundant stories fetches and wasted batch work.
      mockGetProjectsForWorkspace.mockResolvedValueOnce({
        data: [
          { gid: "p1", name: "Project 1" },
          { gid: "p2", name: "Project 2" },
        ],
      });

      const sharedTask = makeTask("shared", "Multi-homed task");
      mockGetTasksForProject
        .mockResolvedValueOnce({ data: [sharedTask] })
        .mockResolvedValueOnce({ data: [sharedTask] });
      // Only ONE stories fetch should happen — for the first project pass.
      mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { workspaceGid: "1234567890" },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allIds = batches.flatMap((b) => b.documents.map((d) => d.id));
      // Task is emitted exactly once despite appearing in both project lists.
      expect(allIds).toEqual(["task-shared"]);
      // And stories were fetched exactly once — not twice.
      expect(mockGetStoriesForTask).toHaveBeenCalledTimes(1);
      // Entity-scoped id (no project prefix).
      expect(allIds[0]).not.toContain("p1#");
      expect(allIds[0]).not.toContain("p2#");
    });

    test("includes comments in document content", async () => {
      mockGetTasksForProject.mockResolvedValueOnce({
        data: [makeTask("t1", "Task with comments")],
      });
      mockGetStoriesForTask.mockResolvedValueOnce({
        data: [
          {
            type: "comment",
            text: "This is a comment",
            created_by: { name: "Reviewer" },
            created_at: "2024-01-16T12:00:00.000Z",
          },
          {
            type: "system",
            text: "moved to Section A",
            created_by: { name: "System" },
            created_at: "2024-01-16T11:00:00.000Z",
          },
        ],
      });

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
      // System stories should be filtered out
      expect(content).not.toContain("moved to");
    });

    test("filters tasks by tagsToSkip", async () => {
      const tasks = [
        makeTask("t1", "Good task"),
        makeTask("t2", "Internal task", { tags: ["internal"] }),
        makeTask("t3", "Another good task"),
      ];

      mockGetTasksForProject.mockResolvedValueOnce({ data: tasks });
      mockGetStoriesForTask
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, tagsToSkip: ["internal"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents.map((d) => d.title)).not.toContainEqual(
        expect.stringContaining("Internal task"),
      );
    });

    test("uses checkpoint for incremental sync", async () => {
      const tasks = [
        makeTask("t1", "Old task", {
          modified_at: "2024-01-10T10:00:00.000Z",
        }),
        makeTask("t2", "New task", {
          modified_at: "2024-01-20T10:00:00.000Z",
        }),
      ];

      mockGetTasksForProject.mockResolvedValueOnce({ data: tasks });
      mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: { type: "asana", lastSyncedAt: "2024-01-15T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      // Only the task modified after the checkpoint should be included
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toContain("New task");
    });

    test("paginates through multiple pages", async () => {
      const page1Tasks = Array.from({ length: 50 }, (_, i) =>
        makeTask(`t${i + 1}`, `Task ${i + 1}`),
      );
      const page2Tasks = [makeTask("t51", "Task 51")];

      mockGetTasksForProject
        .mockResolvedValueOnce({
          data: page1Tasks,
          _response: { next_page: { offset: "abc123" } },
        })
        .mockResolvedValueOnce({
          data: page2Tasks,
        });

      // Stories for all tasks
      for (let i = 0; i < 51; i++) {
        mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });
      }

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

    test("sets checkpoint from last task modified_at", async () => {
      const tasks = [
        makeTask("t1", "First", {
          modified_at: "2024-01-15T10:00:00.000Z",
        }),
        makeTask("t2", "Second", {
          modified_at: "2024-01-20T15:00:00.000Z",
        }),
      ];

      mockGetTasksForProject.mockResolvedValueOnce({ data: tasks });
      mockGetStoriesForTask
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].checkpoint.type).toBe("asana");
      expect(batches[0].checkpoint.lastSyncedAt).toBe(
        "2024-01-20T15:00:00.000Z",
      );
    });

    test("discovers all workspace projects when projectGids not specified", async () => {
      mockGetProjectsForWorkspace.mockResolvedValueOnce({
        data: [
          { gid: "p1", name: "Project 1" },
          { gid: "p2", name: "Project 2" },
        ],
      });

      mockGetTasksForProject
        .mockResolvedValueOnce({
          data: [makeTask("t1", "Task from P1")],
        })
        .mockResolvedValueOnce({
          data: [makeTask("t2", "Task from P2")],
        });

      mockGetStoriesForTask
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { workspaceGid: "1234567890" },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].documents[0].title).toContain("Task from P1");
      expect(batches[1].documents[0].title).toContain("Task from P2");
    });

    test("handles empty project gracefully", async () => {
      mockGetTasksForProject.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].hasMore).toBe(false);
    });

    test("includes metadata in document", async () => {
      mockGetTasksForProject.mockResolvedValueOnce({
        data: [makeTask("t1", "Tagged task", { tags: ["bug", "p1"] })],
      });
      mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const doc = batches[0].documents[0];
      expect(doc.metadata).toMatchObject({
        taskGid: "t1",
        completed: false,
        projects: ["My Project"],
        assignee: "Test User",
        tags: ["bug", "p1"],
      });
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });

    test("builds correct sourceUrl from task permalink_url", async () => {
      mockGetTasksForProject.mockResolvedValueOnce({
        data: [makeTask("t42", "Deep link task")],
      });
      mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://app.asana.com/0/111111/t42",
      );
    });

    test("advances checkpoint even when all tasks are filtered by tagsToSkip", async () => {
      // Regression: if every task in a batch is tags-skipped, the checkpoint
      // must still advance to the last fetched task's `modified_at`, otherwise
      // incremental sync will re-fetch the same window forever.
      const skippedTasks = [
        makeTask("t1", "Skipped one", {
          tags: ["internal"],
          modified_at: "2024-05-01T10:00:00.000Z",
        }),
        makeTask("t2", "Skipped two", {
          tags: ["internal"],
          modified_at: "2024-05-10T10:00:00.000Z",
        }),
      ];

      mockGetTasksForProject.mockResolvedValueOnce({ data: skippedTasks });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, tagsToSkip: ["internal"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(0);
      // Checkpoint must advance to the last fetched task's modified_at,
      // not stay at the previous lastSyncedAt.
      expect(batches[0].checkpoint.lastSyncedAt).toBe(
        "2024-05-10T10:00:00.000Z",
      );
    });

    test("propagates errors when tasks endpoint fails", async () => {
      mockGetTasksForProject.mockRejectedValueOnce(
        new Error("500 Internal Server Error"),
      );

      await expect(async () => {
        for await (const _ of connector.sync({
          config: validConfig,
          credentials,
          checkpoint: null,
        })) {
          // should not reach past the throw
        }
      }).rejects.toThrow("500 Internal Server Error");
    });

    test("throws for invalid config during sync", async () => {
      await expect(async () => {
        for await (const _ of connector.sync({
          config: {},
          credentials,
          checkpoint: null,
        })) {
          // should not reach here
        }
      }).rejects.toThrow("Invalid Asana configuration");
    });

    test("tracks sub-resource failures without blocking sync", async () => {
      mockGetTasksForProject.mockResolvedValueOnce({
        data: [makeTask("t1", "Task with broken stories")],
      });
      mockGetStoriesForTask.mockRejectedValueOnce(new Error("403 Forbidden"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].failures).toHaveLength(1);
      expect(batches[0].failures?.[0].resource).toBe("stories");
    });

    test("paginates stories across multiple pages", async () => {
      mockGetTasksForProject.mockResolvedValueOnce({
        data: [makeTask("t1", "Task with many comments")],
      });

      // Stories API returns two pages
      const page1Stories = Array.from({ length: 100 }, (_, i) => ({
        type: "comment",
        text: `Comment ${i + 1}`,
        created_by: { name: "Alice" },
        created_at: "2024-01-16T12:00:00.000Z",
      }));
      const page2Stories = [
        {
          type: "comment",
          text: "Comment 101",
          created_by: { name: "Bob" },
          created_at: "2024-01-16T12:01:00.000Z",
        },
      ];

      mockGetStoriesForTask
        .mockResolvedValueOnce({
          data: page1Stories,
          _response: { next_page: { offset: "st-page-2" } },
        })
        .mockResolvedValueOnce({
          data: page2Stories,
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const content = batches[0].documents[0].content;
      expect(content).toContain("Comment 1");
      expect(content).toContain("Comment 100");
      expect(content).toContain("Comment 101");
      expect(mockGetStoriesForTask).toHaveBeenCalledTimes(2);
    });

    test("checkpoint is monotonic across projects (no regression)", async () => {
      // Two workspace projects: P1 has a newer task, P2 has an older one.
      // The final checkpoint must not regress below P1's high-water mark.
      mockGetProjectsForWorkspace.mockResolvedValueOnce({
        data: [
          { gid: "p1", name: "Project 1" },
          { gid: "p2", name: "Project 2" },
        ],
      });

      mockGetTasksForProject
        .mockResolvedValueOnce({
          data: [
            makeTask("t1", "Newer task in P1", {
              modified_at: "2024-02-20T10:00:00.000Z",
            }),
          ],
        })
        .mockResolvedValueOnce({
          data: [
            makeTask("t2", "Older task in P2", {
              modified_at: "2024-02-01T10:00:00.000Z",
            }),
          ],
        });

      mockGetStoriesForTask
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { workspaceGid: "1234567890" },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Last batch (from P2) must still carry the high-water mark from P1.
      const finalBatch = batches[batches.length - 1];
      expect(finalBatch.checkpoint.lastSyncedAt).toBe(
        "2024-02-20T10:00:00.000Z",
      );
    });

    test("empty last project does not regress checkpoint to previous lastSyncedAt", async () => {
      mockGetProjectsForWorkspace.mockResolvedValueOnce({
        data: [
          { gid: "p1", name: "Project 1" },
          { gid: "p2", name: "Empty Project" },
        ],
      });

      mockGetTasksForProject
        .mockResolvedValueOnce({
          data: [
            makeTask("t1", "Task in P1", {
              modified_at: "2024-03-05T10:00:00.000Z",
            }),
          ],
        })
        .mockResolvedValueOnce({ data: [] });

      mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { workspaceGid: "1234567890" },
        credentials,
        checkpoint: {
          type: "asana",
          lastSyncedAt: "2024-01-01T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      const finalBatch = batches[batches.length - 1];
      expect(finalBatch.checkpoint.lastSyncedAt).toBe(
        "2024-03-05T10:00:00.000Z",
      );
    });

    test("multi-page scan does not advance checkpoint until final batch", async () => {
      // Intermediate batches must keep the old checkpoint.
      const page1Tasks = [
        makeTask("t1", "Page 1 task", {
          modified_at: "2024-05-01T10:00:00.000Z",
        }),
      ];
      const page2Tasks = [
        makeTask("t2", "Page 2 task", {
          modified_at: "2024-05-02T10:00:00.000Z",
        }),
      ];

      mockGetTasksForProject
        .mockResolvedValueOnce({
          data: page1Tasks,
          _response: { next_page: { offset: "page-2" } },
        })
        .mockResolvedValueOnce({ data: page2Tasks });
      mockGetStoriesForTask
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "asana",
          lastSyncedAt: "2024-01-01T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[0].checkpoint.lastSyncedAt).toBe(
        "2024-01-01T00:00:00.000Z",
      );
      expect(batches[1].hasMore).toBe(false);
      expect(batches[1].checkpoint.lastSyncedAt).toBe(
        "2024-05-02T10:00:00.000Z",
      );
    });

    test("multi-project scan advances checkpoint only on last project's last batch", async () => {
      mockGetProjectsForWorkspace.mockResolvedValueOnce({
        data: [
          { gid: "p1", name: "Project 1" },
          { gid: "p2", name: "Project 2" },
        ],
      });

      mockGetTasksForProject
        .mockResolvedValueOnce({
          data: [
            makeTask("t1", "Newer task in P1", {
              modified_at: "2024-06-15T10:00:00.000Z",
            }),
          ],
        })
        .mockResolvedValueOnce({
          data: [
            makeTask("t2", "Older task in P2", {
              modified_at: "2024-06-10T10:00:00.000Z",
            }),
          ],
        });

      mockGetStoriesForTask
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          workspaceGid: "1234567890",
        },
        credentials,
        checkpoint: {
          type: "asana",
          lastSyncedAt: "2024-01-01T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      // P1 is not the last project: must not advance.
      expect(batches[0].hasMore).toBe(true);
      expect(batches[0].checkpoint.lastSyncedAt).toBe(
        "2024-01-01T00:00:00.000Z",
      );
      // P2 last batch: must advance to the global max across both projects.
      expect(batches[1].hasMore).toBe(false);
      expect(batches[1].checkpoint.lastSyncedAt).toBe(
        "2024-06-15T10:00:00.000Z",
      );
    });

    test("intermediate batch with all tasks filtered by tagsToSkip does not advance checkpoint", async () => {
      // Page 1's filtered max is higher than page 2's kept task to prove
      // progress advances on filtered tasks too.
      const page1Tasks = [
        makeTask("t1", "Skipped", {
          tags: ["internal"],
          modified_at: "2024-07-05T10:00:00.000Z",
        }),
        makeTask("t2", "Also skipped", {
          tags: ["internal"],
          modified_at: "2024-07-10T10:00:00.000Z",
        }),
      ];
      const page2Tasks = [
        makeTask("t3", "Kept", {
          modified_at: "2024-07-06T10:00:00.000Z",
        }),
      ];

      mockGetTasksForProject
        .mockResolvedValueOnce({
          data: page1Tasks,
          _response: { next_page: { offset: "page-2" } },
        })
        .mockResolvedValueOnce({ data: page2Tasks });
      mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, tagsToSkip: ["internal"] },
        credentials,
        checkpoint: {
          type: "asana",
          lastSyncedAt: "2024-01-01T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].checkpoint.lastSyncedAt).toBe(
        "2024-01-01T00:00:00.000Z",
      );
      expect(batches[1].documents).toHaveLength(1);
      // Final checkpoint still uses the max from the filtered first page.
      expect(batches[1].checkpoint.lastSyncedAt).toBe(
        "2024-07-10T10:00:00.000Z",
      );
    });

    test("final batch fully filtered by tagsToSkip still advances checkpoint to accumulated max", async () => {
      const page1Tasks = [
        makeTask("t1", "Kept", {
          modified_at: "2024-08-01T10:00:00.000Z",
        }),
      ];
      const page2Tasks = [
        makeTask("t2", "Skipped last", {
          tags: ["internal"],
          modified_at: "2024-08-05T10:00:00.000Z",
        }),
      ];

      mockGetTasksForProject
        .mockResolvedValueOnce({
          data: page1Tasks,
          _response: { next_page: { offset: "page-2" } },
        })
        .mockResolvedValueOnce({ data: page2Tasks });
      mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, tagsToSkip: ["internal"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[1].documents).toHaveLength(0);
      expect(batches[1].hasMore).toBe(false);
      // advanceProgress ran on the filtered task, so max is its modified_at
      // even though no document was emitted on the final batch.
      expect(batches[1].checkpoint.lastSyncedAt).toBe(
        "2024-08-05T10:00:00.000Z",
      );
    });

    test("interrupted run does not emit advanced checkpoint (error before final batch)", async () => {
      // A later page failure must not make the last emitted batch advance the checkpoint.
      const page1Tasks = [
        makeTask("t1", "Survived before crash", {
          modified_at: "2024-09-10T10:00:00.000Z",
        }),
      ];

      mockGetTasksForProject
        .mockResolvedValueOnce({
          data: page1Tasks,
          _response: { next_page: { offset: "page-2" } },
        })
        .mockRejectedValueOnce(new Error("500 upstream blew up"));
      mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      await expect(async () => {
        for await (const batch of connector.sync({
          config: validConfig,
          credentials,
          checkpoint: {
            type: "asana",
            lastSyncedAt: "2024-01-01T00:00:00.000Z",
          },
        })) {
          batches.push(batch);
        }
      }).rejects.toThrow("500 upstream blew up");

      expect(batches).toHaveLength(1);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[0].checkpoint.lastSyncedAt).toBe(
        "2024-01-01T00:00:00.000Z",
      );
    });

    test("project discovery (workspace listing) applies rateLimit", async () => {
      mockGetProjectsForWorkspace
        .mockResolvedValueOnce({
          data: [{ gid: "p1", name: "P1" }],
          _response: { next_page: { offset: "wp-page-2" } },
        })
        .mockResolvedValueOnce({
          data: [{ gid: "p2", name: "P2" }],
        });
      mockGetTasksForProject.mockResolvedValue({ data: [] });

      const rateLimitSpy = vi.spyOn(
        connector as unknown as RateLimitedConnector,
        "rateLimit",
      );

      for await (const _ of connector.sync({
        config: { workspaceGid: "1234567890" },
        credentials,
        checkpoint: null,
      })) {
        // drain
      }

      // Minimum expected calls:
      //  2 × getProjectsForWorkspace pagination (workspace listing)
      //  2 × getTasksForProject (per resolved project)
      expect(rateLimitSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    test("project discovery (explicit projectGids) applies rateLimit per project", async () => {
      mockGetProject.mockResolvedValue({
        data: { gid: "p1", name: "P1" },
      });
      mockGetTasksForProject.mockResolvedValue({ data: [] });

      const rateLimitSpy = vi.spyOn(
        connector as unknown as RateLimitedConnector,
        "rateLimit",
      );

      for await (const _ of connector.sync({
        config: {
          workspaceGid: "1234567890",
          projectGids: ["p1", "p2", "p3"],
        },
        credentials,
        checkpoint: null,
      })) {
        // drain
      }

      // Minimum expected:
      //  3 × getProject (one per projectGid)
      //  3 × getTasksForProject (per resolved project)
      expect(rateLimitSpy.mock.calls.length).toBeGreaterThanOrEqual(6);
    });

    test("stories pagination applies rateLimit between pages", async () => {
      mockGetTasksForProject.mockResolvedValueOnce({
        data: [makeTask("t1", "Task with paginated stories")],
      });

      // Two pages of stories — paginateAll should call rateLimit before each.
      mockGetStoriesForTask
        .mockResolvedValueOnce({
          data: [
            {
              type: "comment",
              text: "page1",
              created_by: { name: "Alice" },
              created_at: "2024-01-16T12:00:00.000Z",
            },
          ],
          _response: { next_page: { offset: "story-page-2" } },
        })
        .mockResolvedValueOnce({
          data: [
            {
              type: "comment",
              text: "page2",
              created_by: { name: "Bob" },
              created_at: "2024-01-16T12:01:00.000Z",
            },
          ],
        });

      // Spy on the connector's protected rateLimit (cast to access it in test).
      const rateLimitSpy = vi.spyOn(
        connector as unknown as RateLimitedConnector,
        "rateLimit",
      );

      for await (const _ of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        // drain
      }

      // Expected rateLimit calls:
      //  1 × before top-level tasks batch fetch
      //  2 × inside paginateAll (once per stories page)
      // Minimum expected: 3. Allow more if base class adds throttling.
      expect(rateLimitSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  /**
   * 429 retry behaviour. Asana's JS SDK does not retry on rate-limit
   * responses; the connector wraps calls in its own retry layer.
   */
  describe("429 retry", () => {
    function rateLimitedError(retryAfterSec?: number) {
      const err = new Error("429 Too Many Requests") as Error & {
        status: number;
        response: {
          status: number;
          headers: Record<string, string>;
        };
      };
      err.status = 429;
      err.response = {
        status: 429,
        headers:
          retryAfterSec !== undefined
            ? { "retry-after": String(retryAfterSec) }
            : {},
      };
      return err;
    }

    test("retries on 429 and succeeds on second attempt", async () => {
      mockGetUser
        .mockRejectedValueOnce(rateLimitedError(0))
        .mockResolvedValueOnce({ data: { gid: "123", name: "Test User" } });

      const result = await connector.testConnection({
        config: {
          workspaceGid: "1234567890",
        },
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockGetUser).toHaveBeenCalledTimes(2);
    });

    test("does not retry on non-429 errors", async () => {
      mockGetUser.mockRejectedValueOnce(new Error("500 Internal"));

      const result = await connector.testConnection({
        config: { workspaceGid: "1234567890" },
        credentials,
      });

      expect(result.success).toBe(false);
      // Single call, no retry for 500.
      expect(mockGetUser).toHaveBeenCalledTimes(1);
    });

    test("gives up after MAX_RETRY_ATTEMPTS consecutive 429s", async () => {
      // All 4 attempts fail (1 initial + 3 retries = 4).
      mockGetUser.mockRejectedValue(rateLimitedError(0));

      const result = await connector.testConnection({
        config: { workspaceGid: "1234567890" },
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("429");
      // Initial + 3 retries = 4 total.
      expect(mockGetUser).toHaveBeenCalledTimes(4);
    });

    test("honors Retry-After header value", async () => {
      mockGetUser
        .mockRejectedValueOnce(rateLimitedError(0))
        .mockResolvedValueOnce({ data: { gid: "123", name: "Test User" } });

      const start = Date.now();
      const result = await connector.testConnection({
        config: { workspaceGid: "1234567890" },
        credentials,
      });
      const elapsed = Date.now() - start;

      expect(result.success).toBe(true);
      // Retry-After=0 means retry immediately. Ensure we did not pay full
      // exponential backoff delay (≥1000ms) — we respected the header.
      expect(elapsed).toBeLessThan(800);
    });
  });

  /**
   * Workspace scope drift — explicit projectGids must belong to the
   * configured workspaceGid. PAT can span multiple workspaces.
   */
  describe("workspace scope validation", () => {
    test("succeeds when explicit project belongs to configured workspace", async () => {
      mockGetProject.mockResolvedValueOnce({
        data: {
          gid: "111111",
          name: "My Project",
          workspace: { gid: "1234567890" }, // matches workspaceGid
        },
      });
      mockGetTasksForProject.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          workspaceGid: "1234567890",
          projectGids: ["111111"],
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
    });

    test("throws when explicit project belongs to a different workspace", async () => {
      mockGetProject.mockResolvedValueOnce({
        data: {
          gid: "222222",
          name: "Stray Project",
          workspace: { gid: "9999999999" }, // different workspace
        },
      });

      await expect(async () => {
        for await (const _ of connector.sync({
          config: {
            workspaceGid: "1234567890",
            projectGids: ["222222"],
          },
          credentials,
          checkpoint: null,
        })) {
          // should not yield any batches
        }
      }).rejects.toThrow(/does not match the configured workspace/);
    });

    test("workspace discovery path is unaffected (no projectGids)", async () => {
      mockGetProjectsForWorkspace.mockResolvedValueOnce({
        data: [{ gid: "p1", name: "P1" }],
      });
      mockGetTasksForProject.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { workspaceGid: "1234567890" },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      // No getProject calls since we went through workspace discovery.
      expect(mockGetProject).not.toHaveBeenCalled();
    });
  });

  /**
   * Rich text extraction — Asana html_notes / html_text parsed via cheerio
   * so formatting and @mentions survive into the indexed document.
   */
  describe("rich text extraction", () => {
    beforeEach(() => {
      // Tasks in these tests use validConfig (explicit projectGids), so the
      // connector hits getProject for workspace validation. Provide a project
      // whose workspace matches validConfig.workspaceGid.
      mockGetProject.mockResolvedValue({
        data: {
          gid: "111111",
          name: "My Project",
          workspace: { gid: "1234567890" },
        },
      });
    });

    test("extractAsanaHtml preserves @mention as marker when anchor text is empty", () => {
      const html =
        '<body>Please ask <a data-asana-gid="98765"></a> for review.</body>';
      const text = extractAsanaHtml(html);
      expect(text).toContain("[@asana:98765]");
      expect(text).toContain("for review");
    });

    test("extractAsanaHtml formats lists with bullets", () => {
      const html =
        "<body><ul><li>one</li><li>two</li><li>three</li></ul></body>";
      const text = extractAsanaHtml(html);
      expect(text).toContain("- one");
      expect(text).toContain("- two");
      expect(text).toContain("- three");
    });

    test("extractAsanaHtml returns empty string for empty input", () => {
      expect(extractAsanaHtml("")).toBe("");
    });

    test("task uses html_notes when present", async () => {
      const richTask = {
        gid: "tr1",
        name: "Rich task",
        notes: "plain fallback",
        html_notes:
          '<body>Rich <strong>bold</strong> with <a data-asana-gid="777"></a></body>',
        completed: false,
        modified_at: "2024-01-15T10:00:00.000Z",
        created_at: "2024-01-10T10:00:00.000Z",
        permalink_url: "https://app.asana.com/0/111111/tr1",
        assignee: { name: "Test User" },
        projects: [{ name: "My Project" }],
        tags: [],
      };

      mockGetTasksForProject.mockResolvedValueOnce({ data: [richTask] });
      mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const content = batches[0].documents[0].content;
      expect(content).toContain("Rich bold");
      expect(content).toContain("[@asana:777]");
      // Should NOT show plain fallback when html was used.
      expect(content).not.toContain("plain fallback");
    });

    test("task falls back to plain notes when html_notes is empty", async () => {
      const plainTask = {
        gid: "tp1",
        name: "Plain task",
        notes: "plain only",
        html_notes: "",
        completed: false,
        modified_at: "2024-01-15T10:00:00.000Z",
        created_at: "2024-01-10T10:00:00.000Z",
        permalink_url: "https://app.asana.com/0/111111/tp1",
        assignee: { name: "Test User" },
        projects: [{ name: "My Project" }],
        tags: [],
      };

      mockGetTasksForProject.mockResolvedValueOnce({ data: [plainTask] });
      mockGetStoriesForTask.mockResolvedValueOnce({ data: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].content).toContain("plain only");
    });

    test("story uses html_text when present (preserves mentions)", async () => {
      mockGetTasksForProject.mockResolvedValueOnce({
        data: [makeTask("t1", "Task with rich comment")],
      });
      mockGetStoriesForTask.mockResolvedValueOnce({
        data: [
          {
            type: "comment",
            text: "plain fallback comment",
            html_text:
              '<body>Nice, pinging <a data-asana-gid="555"></a> to review</body>',
            created_by: { name: "Reviewer" },
            created_at: "2024-01-16T12:00:00.000Z",
          },
        ],
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const content = batches[0].documents[0].content;
      expect(content).toContain("Nice, pinging");
      expect(content).toContain("[@asana:555]");
      expect(content).toContain("to review");
      expect(content).not.toContain("plain fallback comment");
    });

    test("story falls back to plain text when html_text is missing", async () => {
      mockGetTasksForProject.mockResolvedValueOnce({
        data: [makeTask("t1", "Task with plain comment")],
      });
      mockGetStoriesForTask.mockResolvedValueOnce({
        data: [
          {
            type: "comment",
            text: "plain-only comment body",
            // no html_text
            created_by: { name: "Reviewer" },
            created_at: "2024-01-16T12:00:00.000Z",
          },
        ],
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].content).toContain(
        "plain-only comment body",
      );
    });
  });
});
