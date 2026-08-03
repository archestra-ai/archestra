import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRestoreSkillVersion } from "@/lib/skills/skill.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getSkills: vi.fn(),
    getSkill: vi.fn(),
    getSkillSourceRepos: vi.fn(),
    getSkillUsageStatistics: vi.fn(),
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

/**
 * The restore re-reads both the version being restored and the current head, so
 * it decides the no-op case from the head it just confirmed rather than from a
 * hash the caller passed in. Version 12 is the head throughout these tests.
 */
function mockVersionReads({
  snapshot = versionResponse(),
  head = versionResponse({ content: "current body", contentHash: "hash-head" }),
}: {
  // `versionResponse` is cast to `never` to satisfy the generated SDK's return
  // type, so naming its shape here would say nothing. Both slots are just
  // whatever `getSkillVersion` resolves to, hit or miss.
  snapshot?: unknown;
  head?: unknown;
} = {}) {
  sdk.getSkillVersion.mockImplementation((async (args: {
    path: { version: number };
  }) => (args.path.version === 12 ? head : snapshot)) as never);
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useRestoreSkillVersion(), { wrapper });
}

const restoreArgs = {
  skillId: "skill-1",
  version: 6,
  expectedHeadVersion: 12,
};

describe("useRestoreSkillVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores by writing the old version's content and files forward", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(12));
    mockVersionReads();
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
    mockVersionReads();
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
    mockVersionReads({ snapshot: versionResponse({ files: [] }) });
    sdk.updateSkill.mockResolvedValue({
      data: { id: "skill-1", latestVersion: 13 },
      error: undefined,
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(sdk.updateSkill).toHaveBeenCalled());

    expect(sdk.updateSkill.mock.calls[0][0].body.files).toEqual([]);
  });

  it("aborts when the skill was edited while the version was being previewed", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(13));

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    expect(sdk.updateSkill).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "This skill changed while you were previewing it. Review the latest version and try again.",
    );
  });

  it("does not write when the chosen version is identical to the current one", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(12));
    mockVersionReads({
      snapshot: versionResponse({ contentHash: "hash-head" }),
    });

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(toast.info).toHaveBeenCalled());

    expect(sdk.updateSkill).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("writes anyway when the head cannot be read, rather than assuming a no-op", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(12));
    // A pruned or unreachable head leaves the shortcut undecidable — that is
    // not evidence the two versions match.
    mockVersionReads({
      head: {
        data: undefined,
        error: { error: { message: "gone", type: "api_not_found_error" } },
      },
    });
    sdk.updateSkill.mockResolvedValue({
      data: { id: "skill-1", latestVersion: 13 },
      error: undefined,
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(sdk.updateSkill).toHaveBeenCalled());

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Restored version 6 — created version 13",
      ),
    );
  });

  it("reports nothing restored when the backend suppressed the fork", async () => {
    sdk.getSkill.mockResolvedValue(skillResponse(12));
    mockVersionReads();
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
    mockVersionReads();
    sdk.updateSkill.mockResolvedValue({
      data: undefined,
      error: { error: { message: "name taken", type: "api_conflict_error" } },
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(toast.success).not.toHaveBeenCalled();
  });
});
