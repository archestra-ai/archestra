import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type {
  ConnectorSyncBatch,
  GroupMembershipYield,
  PermissionSnapshotYield,
  PermissionSyncParams,
} from "@/types";
import { AsanaConnector, extractAsanaHtml } from "./asana-connector";

// Mock asana SDK
const mockGetUser = vi.fn();
const mockGetUsers = vi.fn();
const mockGetProject = vi.fn();
const mockGetProjectsForWorkspace = vi.fn();
const mockGetTasksForProject = vi.fn();
const mockGetStoriesForTask = vi.fn();
const mockGetProjectMembershipsForProject = vi.fn();
const mockGetTeamsForWorkspace = vi.fn();
const mockGetTeamMembershipsForTeam = vi.fn();
const mockGetWorkspaceMembershipsForWorkspace = vi.fn();
const mockGetWorkspace = vi.fn();

vi.mock("asana", () => ({
  ApiClient: class MockApiClient {
    authentications: Record<string, unknown> = {};
  },
  UsersApi: class MockUsersApi {
    getUser = mockGetUser;
    getUsers = mockGetUsers;
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
  ProjectMembershipsApi: class MockProjectMembershipsApi {
    getProjectMembershipsForProject = mockGetProjectMembershipsForProject;
  },
  TeamsApi: class MockTeamsApi {
    getTeamsForWorkspace = mockGetTeamsForWorkspace;
  },
  TeamMembershipsApi: class MockTeamMembershipsApi {
    getTeamMembershipsForTeam = mockGetTeamMembershipsForTeam;
  },
  WorkspaceMembershipsApi: class MockWorkspaceMembershipsApi {
    getWorkspaceMembershipsForWorkspace =
      mockGetWorkspaceMembershipsForWorkspace;
  },
  WorkspacesApi: class MockWorkspacesApi {
    getWorkspace = mockGetWorkspace;
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

  describe("permission sync", () => {
    const WS = "1234567890";

    /** Collection-shaped response page (see extractCollectionData/NextOffset). */
    function page<T>(data: T[], nextOffset?: string) {
      return {
        data,
        ...(nextOffset ? { next_page: { offset: nextOffset } } : {}),
      };
    }

    function permProject(
      gid: string,
      opts?: {
        privacy?: string;
        teamGid?: string;
        name?: string;
        workspaceGid?: string;
      },
    ) {
      return {
        gid,
        name: opts?.name ?? `Project ${gid}`,
        privacy_setting: opts?.privacy ?? "private",
        team: opts?.teamGid ? { gid: opts.teamGid } : null,
        workspace: { gid: opts?.workspaceGid ?? WS },
      };
    }

    function permTask(
      gid: string,
      opts?: { projects?: string[]; followers?: string[] },
    ) {
      return {
        gid,
        projects: (opts?.projects ?? []).map((p) => ({ gid: p })),
        followers: (opts?.followers ?? []).map((f) => ({ gid: f })),
      };
    }

    function userMembership(gid: string) {
      return { member: { gid, resource_type: "user" } };
    }

    function teamMembership(gid: string) {
      return { member: { gid, resource_type: "team" } };
    }

    /** Route getProject/getTasksForProject/memberships by project gid. */
    function stubProjects(
      projects: Record<
        string,
        {
          project: ReturnType<typeof permProject>;
          tasks?: ReturnType<typeof permTask>[];
          memberships?: unknown[];
          membershipsError?: unknown;
        }
      >,
    ) {
      mockGetProject.mockImplementation((gid: string) => {
        const entry = projects[gid];
        if (!entry) return Promise.reject(new Error(`no project ${gid}`));
        return Promise.resolve({ data: entry.project });
      });
      mockGetTasksForProject.mockImplementation((gid: string) => {
        const entry = projects[gid];
        return Promise.resolve(page(entry?.tasks ?? []));
      });
      mockGetProjectMembershipsForProject.mockImplementation((gid: string) => {
        const entry = projects[gid];
        if (entry?.membershipsError) {
          return Promise.reject(entry.membershipsError);
        }
        return Promise.resolve(page(entry?.memberships ?? []));
      });
    }

    function stubWorkspaceUsers(
      users: Array<{ gid: string; email?: string | null; name?: string }>,
    ) {
      mockGetUsers.mockResolvedValue(
        page(
          users.map((u) => ({
            gid: u.gid,
            email: u.email ?? null,
            name: u.name ?? `User ${u.gid}`,
          })),
        ),
      );
    }

    function snapshotParams(
      overrides?: Partial<PermissionSyncParams>,
    ): PermissionSyncParams {
      return {
        config: validConfig,
        credentials,
        cursor: null,
        readIngestedDocuments: async () => ({
          documents: [],
          nextAfterId: null,
        }),
        ...overrides,
      };
    }

    async function collectSnapshot(params: PermissionSyncParams) {
      const yields: PermissionSnapshotYield[] = [];
      for await (const item of connector.syncPermissionSnapshot(params)) {
        yields.push(item);
      }
      return yields;
    }

    async function collectGroups(params: PermissionSyncParams) {
      const yields: GroupMembershipYield[] = [];
      for await (const item of connector.syncGroups(params)) {
        yields.push(item);
      }
      return yields;
    }

    function containerYields(yields: PermissionSnapshotYield[]) {
      return yields.filter(
        (y): y is Extract<PermissionSnapshotYield, { kind: "container" }> =>
          y.kind === "container",
      );
    }

    function documentYields(yields: PermissionSnapshotYield[]) {
      return yields.filter(
        (y): y is Extract<PermissionSnapshotYield, { kind: "document" }> =>
          y.kind === "document",
      );
    }

    beforeEach(() => {
      vi.spyOn(
        connector as unknown as RateLimitedConnector,
        "rateLimit",
      ).mockResolvedValue(undefined);
      stubWorkspaceUsers([
        { gid: "u-alice", email: "alice@example.com", name: "Alice" },
        { gid: "u-bob", email: "bob@example.com", name: "Bob" },
        { gid: "u-hidden", email: null, name: "Hidden" },
      ]);
      mockGetWorkspace.mockResolvedValue({ data: { name: "Acme" } });
      mockGetTeamsForWorkspace.mockResolvedValue(page([]));
      mockGetWorkspaceMembershipsForWorkspace.mockResolvedValue(page([]));
    });

    test("supportsPermissionSync is enabled", () => {
      expect(connector.supportsPermissionSync).toBe(true);
    });

    test("public_to_workspace project grants the workspace-members group plus explicit members", async () => {
      stubProjects({
        "111111": {
          project: permProject("111111", { privacy: "public_to_workspace" }),
          tasks: [permTask("t1", { projects: ["111111"] })],
          memberships: [userMembership("u-alice")],
        },
      });

      const yields = await collectSnapshot(snapshotParams());
      const containers = containerYields(yields);
      const documents = documentYields(yields);

      expect(containers).toHaveLength(1);
      expect(containers[0]).toMatchObject({
        containerKey: "project:111111",
        cursor: "project:111111",
        permissions: {
          isPublic: false,
          users: ["alice@example.com"],
          groups: [`workspace-members:${WS}`],
        },
      });
      expect(containers[0].audienceResolutionFailed ?? false).toBe(false);
      expect(documents).toEqual([
        {
          kind: "document",
          sourceId: "task-t1",
          containerKey: "project:111111",
          cursor: "project:111111",
        },
      ]);
    });

    test("private project grants direct users and member teams; hidden-email member is dropped fail-closed", async () => {
      stubProjects({
        "111111": {
          project: permProject("111111"),
          tasks: [permTask("t1", { projects: ["111111"] })],
          memberships: [],
        },
      });
      // Membership pagination: the team lands on page two.
      mockGetProjectMembershipsForProject
        .mockResolvedValueOnce(
          page([userMembership("u-alice"), userMembership("u-hidden")], "off2"),
        )
        .mockResolvedValueOnce(page([teamMembership("team-eng")]));

      const yields = await collectSnapshot(snapshotParams());
      const [container] = containerYields(yields);

      expect(container.permissions).toEqual({
        isPublic: false,
        users: ["alice@example.com"],
        groups: ["team:team-eng"],
      });
      expect(container.audienceResolutionFailed ?? false).toBe(false);
    });

    test("hidden-email direct member resolves through the admin mapping", async () => {
      stubProjects({
        "111111": {
          project: permProject("111111"),
          tasks: [permTask("t1", { projects: ["111111"] })],
          memberships: [userMembership("u-hidden")],
        },
      });

      const yields = await collectSnapshot(
        snapshotParams({
          resolveMappedEmail: (accountId) =>
            accountId === "u-hidden" ? "mapped@example.com" : null,
        }),
      );

      expect(containerYields(yields)[0].permissions.users).toEqual([
        "mapped@example.com",
      ]);
    });

    test("deprecated private_to_team grants the project's own team", async () => {
      stubProjects({
        "111111": {
          project: permProject("111111", {
            privacy: "private_to_team",
            teamGid: "team-legacy",
          }),
          tasks: [permTask("t1", { projects: ["111111"] })],
          memberships: [],
        },
      });

      const yields = await collectSnapshot(snapshotParams());
      expect(containerYields(yields)[0].permissions.groups).toEqual([
        "team:team-legacy",
      ]);
    });

    test("multi-homed task gets a nested union container and is assigned exactly once", async () => {
      stubProjects({
        "111111": {
          project: permProject("111111"),
          tasks: [
            permTask("t1", { projects: ["111111", "222222"] }),
            permTask("t2", { projects: ["111111"] }),
          ],
          memberships: [userMembership("u-alice")],
        },
        "222222": {
          project: permProject("222222"),
          tasks: [
            permTask("t1", { projects: ["111111", "222222"] }),
            permTask("t3", { projects: ["222222"] }),
          ],
          memberships: [userMembership("u-bob")],
        },
      });

      const yields = await collectSnapshot(
        snapshotParams({
          config: { workspaceGid: WS, projectGids: ["111111", "222222"] },
        }),
      );

      const containers = containerYields(yields);
      expect(containers.map((c) => c.containerKey)).toEqual([
        "project:111111",
        "project:111111/multi:222222",
        "project:222222",
      ]);
      const union = containers[1];
      expect(union.permissions.users).toEqual([
        "alice@example.com",
        "bob@example.com",
      ]);
      expect(union.cursor).toBe("project:111111");

      const documents = documentYields(yields);
      expect(documents).toEqual([
        expect.objectContaining({
          sourceId: "task-t1",
          containerKey: "project:111111/multi:222222",
        }),
        expect.objectContaining({
          sourceId: "task-t2",
          containerKey: "project:111111",
        }),
        expect.objectContaining({
          sourceId: "task-t3",
          containerKey: "project:222222",
        }),
      ]);
    });

    test("multi-home into an out-of-scope project contributes audience without a top-level container", async () => {
      stubProjects({
        "111111": {
          project: permProject("111111"),
          tasks: [permTask("t1", { projects: ["111111", "999999"] })],
          memberships: [userMembership("u-alice")],
        },
        "999999": {
          project: permProject("999999"),
          memberships: [userMembership("u-bob")],
        },
      });

      const yields = await collectSnapshot(snapshotParams());
      const containers = containerYields(yields);

      expect(containers.map((c) => c.containerKey)).toEqual([
        "project:111111",
        "project:111111/multi:999999",
      ]);
      expect(containers[1].permissions.users).toEqual([
        "alice@example.com",
        "bob@example.com",
      ]);
      // The out-of-scope project is an audience source only — its tasks were
      // never enumerated.
      expect(mockGetTasksForProject).not.toHaveBeenCalledWith(
        "999999",
        expect.anything(),
      );
    });

    test("an unreadable project audience fail-closes the container but keeps its documents assigned", async () => {
      stubProjects({
        "111111": {
          project: permProject("111111"),
          tasks: [permTask("t1", { projects: ["111111"] })],
          membershipsError: Object.assign(new Error("boom"), { status: 500 }),
        },
      });

      const yields = await collectSnapshot(snapshotParams());
      const [container] = containerYields(yields);

      expect(container.audienceResolutionFailed).toBe(true);
      expect(container.permissions).toEqual({
        isPublic: false,
        users: [],
        groups: [],
      });
      expect(documentYields(yields)).toEqual([
        expect.objectContaining({
          sourceId: "task-t1",
          containerKey: "project:111111",
        }),
      ]);
    });

    test("an empty project emits a boundary container without resolving its audience", async () => {
      stubProjects({
        "111111": {
          project: permProject("111111"),
          tasks: [],
          memberships: [userMembership("u-alice")],
        },
      });

      const yields = await collectSnapshot(snapshotParams());

      expect(yields).toEqual([
        {
          kind: "container",
          containerKey: "project:111111",
          permissions: { isPublic: false, users: [], groups: [] },
          audienceResolutionFailed: false,
          cursor: "project:111111",
        },
      ]);
      expect(mockGetProjectMembershipsForProject).not.toHaveBeenCalled();
    });

    test("task followers become per-document exception users", async () => {
      stubProjects({
        "111111": {
          project: permProject("111111"),
          tasks: [
            permTask("t1", {
              projects: ["111111"],
              followers: ["u-bob", "u-hidden"],
            }),
          ],
          memberships: [userMembership("u-alice")],
        },
      });

      const yields = await collectSnapshot(snapshotParams());
      expect(documentYields(yields)[0].exceptionUsers).toEqual([
        "bob@example.com",
      ]);
    });

    test("resume cursor skips completed top-level containers", async () => {
      stubProjects({
        "111111": {
          project: permProject("111111"),
          tasks: [permTask("t1", { projects: ["111111"] })],
          memberships: [],
        },
        "222222": {
          project: permProject("222222"),
          tasks: [permTask("t2", { projects: ["222222"] })],
          memberships: [],
        },
      });

      const yields = await collectSnapshot(
        snapshotParams({
          config: { workspaceGid: WS, projectGids: ["111111", "222222"] },
          cursor: "project:222222",
        }),
      );

      expect(containerYields(yields).map((c) => c.containerKey)).toEqual([
        "project:222222",
      ]);
      expect(mockGetTasksForProject).not.toHaveBeenCalledWith(
        "111111",
        expect.anything(),
      );
    });

    test("a failed workspace-user walk degrades direct grants but keeps group audiences", async () => {
      mockGetUsers.mockRejectedValue(new Error("users down"));
      stubProjects({
        "111111": {
          project: permProject("111111"),
          tasks: [permTask("t1", { projects: ["111111"] })],
          memberships: [teamMembership("team-eng"), userMembership("u-alice")],
        },
      });

      const yields = await collectSnapshot(snapshotParams());
      const [container] = containerYields(yields);

      expect(container.permissions.groups).toEqual(["team:team-eng"]);
      expect(container.permissions.users).toEqual([]);
      expect(container.audienceResolutionFailed ?? false).toBe(false);
      // One walk attempt per pass, not one per principal.
      expect(mockGetUsers).toHaveBeenCalledTimes(1);
    });

    test("syncGroups yields the workspace-members roster without guests or deactivated users", async () => {
      stubWorkspaceUsers([
        { gid: "u-alice", email: "alice@example.com", name: "Alice" },
        { gid: "u-bob", email: "bob@example.com", name: "Bob" },
        { gid: "u-guest", email: "guest@example.com", name: "Guest" },
        { gid: "u-gone", email: "gone@example.com", name: "Gone" },
      ]);
      mockGetWorkspaceMembershipsForWorkspace.mockResolvedValue(
        page([
          { user: { gid: "u-alice", name: "Alice" } },
          { user: { gid: "u-bob", name: "Bob" }, is_guest: false },
          { user: { gid: "u-guest", name: "Guest" }, is_guest: true },
          { user: { gid: "u-gone", name: "Gone" }, is_active: false },
        ]),
      );

      const yields = await collectGroups(snapshotParams());

      expect(yields[0]).toEqual({
        groupId: `workspace-members:${WS}`,
        name: "Acme workspace members",
        members: [
          {
            accountId: "u-alice",
            displayName: "Alice",
            email: "alice@example.com",
            accountType: "user",
          },
          {
            accountId: "u-bob",
            displayName: "Bob",
            email: "bob@example.com",
            accountType: "user",
          },
        ],
      });
    });

    test("syncGroups team rosters exclude limited-access members and byte-match audience group ids", async () => {
      mockGetTeamsForWorkspace.mockResolvedValue(
        page([{ gid: "team-eng", name: "Engineering" }]),
      );
      mockGetTeamMembershipsForTeam.mockResolvedValue(
        page([
          { user: { gid: "u-alice", name: "Alice" } },
          { user: { gid: "u-bob", name: "Bob" }, is_limited_access: true },
        ]),
      );

      const yields = await collectGroups(snapshotParams());
      const teamYield = yields.find((y) => y.groupId === "team:team-eng");

      expect(teamYield).toEqual({
        groupId: "team:team-eng",
        name: "Engineering",
        members: [
          {
            accountId: "u-alice",
            displayName: "Alice",
            email: "alice@example.com",
            accountType: "user",
          },
        ],
      });
    });

    test("a 403 team roster yields an observed fail-closed empty group and later teams still sync", async () => {
      mockGetTeamsForWorkspace.mockResolvedValue(
        page([
          { gid: "team-locked", name: "Locked" },
          { gid: "team-open", name: "Open" },
        ]),
      );
      mockGetTeamMembershipsForTeam.mockImplementation((teamGid: string) => {
        if (teamGid === "team-locked") {
          return Promise.reject(
            Object.assign(new Error("Forbidden"), { status: 403 }),
          );
        }
        return Promise.resolve(page([{ user: { gid: "u-bob", name: "Bob" } }]));
      });

      const yields = await collectGroups(snapshotParams());

      expect(yields.find((y) => y.groupId === "team:team-locked")).toEqual({
        groupId: "team:team-locked",
        name: "Locked",
        members: [],
        membershipResolutionFailed: true,
      });
      expect(
        yields.find((y) => y.groupId === "team:team-open")?.members,
      ).toHaveLength(1);
    });

    test("a transient team roster failure aborts the group phase instead of truncating", async () => {
      mockGetTeamsForWorkspace.mockResolvedValue(
        page([{ gid: "team-eng", name: "Engineering" }]),
      );
      mockGetTeamMembershipsForTeam.mockRejectedValue(
        Object.assign(new Error("upstream 502"), { status: 502 }),
      );

      await expect(collectGroups(snapshotParams())).rejects.toThrow(
        "upstream 502",
      );
    });

    test("a failed workspace-user walk aborts syncGroups so resolved emails are never overwritten with nulls", async () => {
      mockGetUsers.mockRejectedValue(new Error("users down"));

      await expect(collectGroups(snapshotParams())).rejects.toThrow(
        "users down",
      );
    });
  });
});
