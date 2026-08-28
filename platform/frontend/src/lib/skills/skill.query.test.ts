import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useBulkDeleteSkills,
  useBulkUpdateSkillsVisibility,
  useExternalMcpSkill,
  useRestoreSkillVersion,
  useSkillsList,
  useSkillVersion,
  useSkillVersions,
  useUpdateSkill,
} from "@/lib/skills/skill.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getSkills: vi.fn(),
    getSkill: vi.fn(),
    getSkillSourceRepos: vi.fn(),
    getSkillUsageStatistics: vi.fn(),
    getExternalMcpSkill: vi.fn(),
    getSkillVersion: vi.fn(),
    getSkillVersions: vi.fn(),
    createSkill: vi.fn(),
    updateSkill: vi.fn(),
    updateSkillGithubSync: vi.fn(),
    deleteSkill: vi.fn(),
    restoreSkill: vi.fn(),
    resetSkill: vi.fn(),
    discoverGithubSkills: vi.fn(),
    searchSkillCatalog: vi.fn(),
    previewGithubSkill: vi.fn(),
    importGithubSkills: vi.fn(),
    bulkUpdateSkillsVisibility: vi.fn(),
    bulkDeleteSkills: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

const sdk = vi.mocked(archestraApiSdk);

/**
 * The skill as the server currently has it. Frontmatter lives in columns, not
 * in `content` — `content` is the SKILL.md body alone, exactly as a version
 * snapshot stores it.
 */
function skillResponse(
  latestVersion: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    data: {
      id: "skill-1",
      name: "pdf-tools",
      description: "Work with PDFs.",
      license: null,
      compatibility: null,
      allowedTools: null,
      agentName: null,
      templated: false,
      metadata: {},
      content: "current body",
      latestVersion,
      ...overrides,
    },
    error: undefined,
  } as never;
}

function versionResponse({
  content = "old body",
  contentHash = "hash-old",
  files = [
    {
      id: "file-1",
      versionId: "version-1",
      path: "scripts/extract.py",
      content: "print('old')",
      encoding: "utf8" as const,
      kind: "script" as const,
      createdAt: "2026-08-01T10:00:00.000Z",
    },
  ],
} = {}) {
  return {
    data: {
      id: "version-1",
      skillId: "skill-1",
      version: 6,
      content,
      contentHash,
      createdAt: "2026-08-01T10:00:00.000Z",
      files,
    },
    error: undefined,
  } as never;
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return {
    ...renderHook(() => useRestoreSkillVersion(), { wrapper }),
    queryClient,
  };
}

/** Version 12 is the head the preview was rendered against throughout. */
const restoreArgs = {
  skillId: "skill-1",
  version: 6,
  baseVersion: 12,
};

describe("useSkillsList", () => {
  it("loads every page for a mixed-source collection", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `skill-${index}`,
      name: `skill-${index}`,
    }));
    sdk.getSkills
      .mockResolvedValueOnce({
        data: {
          data: firstPage,
          pagination: { hasNext: true },
        },
        error: undefined,
      } as never)
      .mockResolvedValueOnce({
        data: {
          data: [{ id: "skill-100", name: "skill-100" }],
          pagination: { hasNext: false },
        },
        error: undefined,
      } as never);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useSkillsList({}), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(101);
    expect(sdk.getSkills).toHaveBeenNthCalledWith(1, {
      query: { limit: 100, offset: 0 },
    });
    expect(sdk.getSkills).toHaveBeenNthCalledWith(2, {
      query: { limit: 100, offset: 100 },
    });
  });
});

describe("useExternalMcpSkill", () => {
  it("clears a removed external Skill when its refetch returns not found", async () => {
    sdk.getExternalMcpSkill.mockResolvedValue({
      data: undefined,
      error: {
        error: {
          message: "External skill not found",
          type: "api_not_found_error",
        },
      },
    } as never);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(
      () => useExternalMcpSkill({ id: "skill-1", mcpServerId: "server-1" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

describe("useRestoreSkillVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores by writing the old version's content and files forward", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(12));
    sdk.getSkillVersion.mockResolvedValue(versionResponse());
    sdk.updateSkill.mockResolvedValue({
      data: { id: "skill-1", latestVersion: 13 },
      error: undefined,
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(sdk.updateSkill).toHaveBeenCalled());

    expect(sdk.updateSkill).toHaveBeenCalledWith({
      path: { id: "skill-1" },
      body: {
        // The API takes a whole SKILL.md, so the snapshot's bare body is
        // republished under the skill's frontmatter. Sending the body alone is
        // rejected outright: "SKILL.md must start with a YAML frontmatter block".
        content: [
          "---",
          'name: "pdf-tools"',
          'description: "Work with PDFs."',
          "---",
          "",
          "old body",
        ].join("\n"),
        files: [
          {
            path: "scripts/extract.py",
            content: "print('old')",
            encoding: "utf8",
          },
        ],
        // The head the preview was rendered against: the route compares and
        // rejects rather than burying an edit that landed in between.
        baseVersion: 12,
      },
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Restored version 6 — created version 13",
      ),
    );
  });

  it("carries the skill's current frontmatter, which versions do not capture", async () => {
    sdk.getSkill.mockResolvedValue(
      skillResponse(12, {
        name: "pdf-toolkit",
        license: "Apache-2.0",
        allowedTools: "Bash(python3) Read",
        templated: true,
      }),
    );
    sdk.getSkillVersion.mockResolvedValue(versionResponse());
    sdk.updateSkill.mockResolvedValue({
      data: { id: "skill-1", latestVersion: 13 },
      error: undefined,
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(sdk.updateSkill).toHaveBeenCalled());

    const { content } = sdk.updateSkill.mock.calls[0][0].body;
    // A restore is an edit of the body, so it must not rename the skill or drop
    // fields it never had a snapshot of.
    expect(content).toContain('name: "pdf-toolkit"');
    expect(content).toContain('license: "Apache-2.0"');
    expect(content).toContain('allowed-tools: "Bash(python3) Read"');
    expect(content).toContain("templated: true");
    expect(content).toContain("old body");
  });

  it("sends an empty files array so a fileless version does not inherit current files", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(12));
    sdk.getSkillVersion.mockResolvedValue(versionResponse({ files: [] }));
    sdk.updateSkill.mockResolvedValue({
      data: { id: "skill-1", latestVersion: 13 },
      error: undefined,
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(sdk.updateSkill).toHaveBeenCalled());

    expect(sdk.updateSkill.mock.calls[0][0].body.files).toEqual([]);
  });

  it("reads the frontmatter fresh, since a frontmatter edit does not move the head", async () => {
    // The skill was renamed after the preview was rendered. That edit forks no
    // version, so the compare-and-set still passes and the restore must carry
    // the new name rather than the one the preview showed.
    sdk.getSkill.mockResolvedValue(skillResponse(12, { name: "renamed" }));
    sdk.getSkillVersion.mockResolvedValue(versionResponse());
    sdk.updateSkill.mockResolvedValue({
      data: { id: "skill-1", latestVersion: 13 },
      error: undefined,
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(sdk.updateSkill).toHaveBeenCalled());

    expect(sdk.updateSkill.mock.calls[0][0].body.content).toContain(
      'name: "renamed"',
    );
  });

  it("reports a rejected compare-and-set as an edit landing under the preview", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(12));
    sdk.getSkillVersion.mockResolvedValue(versionResponse());
    sdk.updateSkill.mockResolvedValue({
      data: undefined,
      // The route raises a second kind of 409 (a name collision), so the
      // internal code — not the status — is what marks this one.
      error: {
        error: {
          message: "has moved to version 13",
          type: "api_conflict_error",
          internal_code: "skill_version_conflict",
        },
      },
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "This skill changed while you were previewing it. Review the latest version and try again.",
    );
  });

  it("reports nothing restored when the backend suppressed the fork", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(12));
    sdk.getSkillVersion.mockResolvedValue(versionResponse());
    // The write went through but the payload hashed equal to the head, so no
    // version was created and `latestVersion` did not move.
    sdk.updateSkill.mockResolvedValue({
      data: { id: "skill-1", latestVersion: 12 },
      error: undefined,
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(toast.info).toHaveBeenCalled());

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      "Version 6 is identical to the current version — nothing to restore.",
    );
  });

  it("reports no success when the write itself fails", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(12));
    sdk.getSkillVersion.mockResolvedValue(versionResponse());
    sdk.updateSkill.mockResolvedValue({
      data: undefined,
      error: {
        error: { message: "boom", type: "api_internal_server_error" },
      },
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not write when either read fails", async () => {
    sdk.getSkill.mockResolvedValue({
      data: undefined,
      error: { error: { message: "gone", type: "api_not_found_error" } },
    } as never);
    sdk.getSkillVersion.mockResolvedValue(versionResponse());

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(sdk.updateSkill).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  /**
   * The cases above fail with an `{ error }` response, which the mutation reads
   * and reports. A rejection is the other kind of failure — the request never
   * reached the API — and it reaches none of those branches. The dialog awaits
   * this mutation and keeps its confirmation open on any failure, so if the
   * mutation stays quiet the user is left clicking an inert button.
   */
  it("reports a write that never reached the API", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(12));
    sdk.getSkillVersion.mockResolvedValue(versionResponse());
    sdk.updateSkill.mockRejectedValue(new Error("Failed to fetch"));

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("reports a read that never reached the API", async () => {
    sdk.getSkill.mockRejectedValue(new Error("Failed to fetch"));
    sdk.getSkillVersion.mockResolvedValue(versionResponse());

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(toast.error).toHaveBeenCalled();
    expect(sdk.updateSkill).not.toHaveBeenCalled();
  });
});

describe("useUpdateSkill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupUpdate() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    return { ...renderHook(() => useUpdateSkill(), { wrapper }), invalidate };
  }

  const editArgs = {
    id: "skill-1",
    body: { content: "---\nname: x\ndescription: y\n---\n\nbody" },
  };

  it("tells the author their copy went stale rather than quoting version numbers", async () => {
    sdk.updateSkill.mockResolvedValue({
      data: undefined,
      error: {
        error: {
          message: 'Skill "pdf-tools" has moved to version 13.',
          type: "api_conflict_error",
          internal_code: "skill_version_conflict",
        },
      },
    } as never);

    const { result, invalidate } = setupUpdate();
    result.current.mutate(editArgs);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    expect(toast.error).toHaveBeenCalledWith(
      "This skill changed while you were editing it. Discard your changes to load the latest version, then reapply them.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    // The editor stays open on the rejected draft, so the head that overtook
    // it has to be pulled for "Discard changes" to have anything current to
    // fall back to — otherwise every retry re-sends the same stale anchor.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["skills", "skill-1"],
    });
  });

  it("still reports a name collision as itself, though it is a 409 too", async () => {
    sdk.updateSkill.mockResolvedValue({
      data: undefined,
      error: {
        error: {
          message: 'A skill named "pdf-tools" already exists',
          type: "api_conflict_error",
        },
      },
    } as never);

    const { result } = setupUpdate();
    result.current.mutate(editArgs);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    expect(toast.error).toHaveBeenCalledWith(
      'A skill named "pdf-tools" already exists',
      expect.anything(),
    );
  });
});

describe("useSkillVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * A version's bytes are immutable, and a snapshot carries every resource file
   * in full (base64 for binaries). Nothing a skill write does can change them,
   * so no skill invalidation may drop them — and skill invalidations are fired
   * from all over the app, not just from this file.
   */
  it("survives a skill invalidation, so a snapshot is downloaded once", async () => {
    sdk.getSkillVersion.mockResolvedValue(versionResponse());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useSkillVersion("skill-1", 6), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(sdk.getSkillVersion).toHaveBeenCalledTimes(1);

    // Stands in for every `invalidateQueries({ queryKey: ["skills"] })` in the
    // app — the skill list, the skill itself, and its version *list* all refresh
    // on a write; the snapshots must not.
    await queryClient.invalidateQueries({ queryKey: ["skills"] });

    expect(sdk.getSkillVersion).toHaveBeenCalledTimes(1);
  });
});

/**
 * The history is read by offset from a list that grows at the *head*, so a
 * version created between two page loads shifts every row down and the next
 * page re-returns rows the previous one already held. The dialog drops the
 * second copy (covered in `skill-version-history-dialog.test.tsx`, "lists a
 * version once when a page boundary re-returns it"); these tests cover the
 * other half — that dropping it must not shorten the offset the *server* is
 * counting against, or the row past the overlap is skipped and never seen.
 */
describe("useSkillVersions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** `versions` newest-first, so a page counts *down* from `startingAt`. */
  function versionsPage({
    startingAt,
    count = 20,
    hasNext = true,
  }: {
    startingAt: number;
    count?: number;
    hasNext?: boolean;
  }) {
    return {
      data: {
        data: Array.from({ length: count }, (_, index) => ({
          id: `version-${startingAt - index}`,
          skillId: "skill-1",
          version: startingAt - index,
          contentHash: `hash-${startingAt - index}`,
          createdAt: "2026-08-01T10:00:00.000Z",
        })),
        pagination: {
          currentPage: 1,
          limit: 20,
          total: 100,
          totalPages: 5,
          hasNext,
          hasPrev: false,
        },
      },
      error: undefined,
    } as never;
  }

  function setupVersions() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    return renderHook(() => useSkillVersions("skill-1"), { wrapper });
  }

  it("asks for the next page at the offset the server counts from", async () => {
    sdk.getSkillVersions.mockResolvedValue(versionsPage({ startingAt: 100 }));

    const { result } = setupVersions();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sdk.getSkillVersions).toHaveBeenNthCalledWith(1, {
      path: { id: "skill-1" },
      query: { limit: 20, offset: 0 },
    });

    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(sdk.getSkillVersions).toHaveBeenNthCalledWith(2, {
      path: { id: "skill-1" },
      query: { limit: 20, offset: 20 },
    });
  });

  it("keeps counting rows the server sent, not rows the caller kept", async () => {
    // A version lands between the two loads, so page 2 starts one row back and
    // re-returns v81. Counting the 39 *distinct* rows would ask for offset 39
    // and skip a version outright — the offset belongs to the server's list.
    sdk.getSkillVersions
      .mockResolvedValueOnce(versionsPage({ startingAt: 100 }))
      .mockResolvedValueOnce(versionsPage({ startingAt: 81 }))
      .mockResolvedValueOnce(versionsPage({ startingAt: 61 }));

    const { result } = setupVersions();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(sdk.getSkillVersions).toHaveBeenNthCalledWith(3, {
      path: { id: "skill-1" },
      query: { limit: 20, offset: 40 },
    });
  });

  it("stops paging once the server reports no next page", async () => {
    sdk.getSkillVersions.mockResolvedValue(
      versionsPage({ startingAt: 3, count: 3, hasNext: false }),
    );

    const { result } = setupVersions();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.hasNextPage).toBe(false);
  });
});

/**
 * A bulk route answers 200 with a per-skill breakdown, so a batch where some
 * skills moved and others did not is a *success* as far as the mutation is
 * concerned. These pin the one place that difference is visible to the user.
 */
describe("bulk skill mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupBulk<T>(hook: () => T) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    return renderHook(hook, { wrapper });
  }

  const visibilityArgs = { skillIds: ["a"], scope: "org" as const };

  it("reports a clean sweep as a plain success", async () => {
    sdk.bulkUpdateSkillsVisibility.mockResolvedValue({
      data: {
        succeeded: [
          { id: "a", name: "alpha" },
          { id: "b", name: "beta" },
        ],
        failed: [],
      },
      error: undefined,
    });
    const { result } = setupBulk(useBulkUpdateSkillsVisibility);

    await act(async () => {
      await result.current.mutateAsync(visibilityArgs);
    });

    expect(toast.success).toHaveBeenCalledWith("Updated 2 skills");
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("names the skills a partial batch left behind", async () => {
    sdk.bulkUpdateSkillsVisibility.mockResolvedValue({
      data: {
        succeeded: [{ id: "a", name: "alpha" }],
        failed: [
          {
            id: "b",
            name: "beta",
            error: 'A skill named "beta" already exists',
          },
        ],
      },
      error: undefined,
    });
    const { result } = setupBulk(useBulkUpdateSkillsVisibility);

    await act(async () => {
      await result.current.mutateAsync(visibilityArgs);
    });

    // Not a success: claiming "Updated 1 skill" would hide that beta is still
    // where it was.
    expect(toast.success).not.toHaveBeenCalled();
    const [message, options] = vi.mocked(toast.warning).mock.calls[0];
    expect(message).toContain("Updated 1 skill");
    expect(message).toContain("1 skill could not be updated");
    expect(options?.description).toContain("beta");
    expect(options?.description).toContain("already exists");
  });

  it("counts the failures it does not name", async () => {
    sdk.bulkDeleteSkills.mockResolvedValue({
      data: {
        succeeded: [],
        failed: ["a", "b", "c", "d", "e"].map((id) => ({
          id,
          name: `skill-${id}`,
          error: "You can only manage your own personal skills",
        })),
      },
      error: undefined,
    });
    const { result } = setupBulk(useBulkDeleteSkills);

    await act(async () => {
      await result.current.mutateAsync(["a", "b", "c", "d", "e"]);
    });

    const [message, options] = vi.mocked(toast.error).mock.calls[0];
    expect(message).toBe("Could not delete 5 skills");
    expect(options?.description).toContain("skill-a, skill-b, skill-c");
    expect(options?.description).toContain("and 2 more");
    // A toast is not a report, so the rest are counted rather than listed.
    expect(options?.description).not.toContain("skill-d");
  });

  it("falls back to the id for a skill that resolved to nothing", async () => {
    sdk.bulkDeleteSkills.mockResolvedValue({
      data: {
        succeeded: [],
        failed: [{ id: "gone-id", name: null, error: "Skill not found" }],
      },
      error: undefined,
    });
    const { result } = setupBulk(useBulkDeleteSkills);

    await act(async () => {
      await result.current.mutateAsync(["gone-id"]);
    });

    const [, options] = vi.mocked(toast.error).mock.calls[0];
    expect(options?.description).toContain("gone-id");
  });
});
