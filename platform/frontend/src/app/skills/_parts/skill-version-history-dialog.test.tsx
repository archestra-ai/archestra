import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import {
  useResetSkill,
  useRestoreSkillVersion,
  useSkill,
  useSkillVersion,
  useSkillVersions,
} from "@/lib/skills/skill.query";
import { SkillVersionHistoryDialog } from "./skill-version-history-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/skills/skill.query", () => ({
  useSkill: vi.fn(),
  useSkillVersions: vi.fn(),
  useSkillVersion: vi.fn(),
  useRestoreSkillVersion: vi.fn(),
  useResetSkill: vi.fn(),
}));

// Monaco needs a real browser layout engine, so both editors stand in as plain
// nodes that still expose the text each side of the diff was given.
vi.mock("@/components/diff-editor", () => ({
  DiffEditor: ({
    original,
    modified,
  }: {
    original: string;
    modified: string;
  }) => (
    <div data-testid="diff">
      <span data-testid="diff-original">{original}</span>
      <span data-testid="diff-modified">{modified}</span>
    </div>
  ),
}));

vi.mock("@/components/editor", () => ({
  Editor: ({ value }: { value: string }) => (
    <div data-testid="editor">{value}</div>
  ),
}));

// A version stores the SKILL.md body alone; frontmatter is not versioned.
const HEAD_BODY = "head body";
const OLD_BODY = "old body";

const versionRow = (version: number, contentHash: string) => ({
  id: `version-${version}`,
  skillId: "skill-1",
  version,
  contentHash,
  createdAt: "2026-08-03T10:00:00.000Z",
});

const versionDetail = ({
  version,
  content,
  contentHash,
  files = [],
}: {
  version: number;
  content: string;
  contentHash: string;
  files?: {
    id: string;
    versionId: string;
    path: string;
    content: string;
    encoding: "utf8" | "base64";
    kind: "reference" | "script" | "asset";
    createdAt: string;
  }[];
}) => ({
  id: `version-${version}`,
  skillId: "skill-1",
  version,
  content,
  contentHash,
  createdAt: "2026-08-03T10:00:00.000Z",
  files,
});

const file = (path: string, content: string) => ({
  id: `file-${path}`,
  versionId: "version-1",
  path,
  content,
  encoding: "utf8" as const,
  kind: "script" as const,
  createdAt: "2026-08-03T10:00:00.000Z",
});

const mutateAsync = vi.fn();
const resetAsync = vi.fn();

function mockSkill(overrides: Record<string, unknown> = {}) {
  vi.mocked(useSkill).mockReturnValue({
    data: {
      id: "skill-1",
      name: "pdf-tools",
      latestVersion: 3,
      sourceType: "manual",
      githubSyncInterval: null,
      ...overrides,
    },
    isPending: false,
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

/** Head is v3; v2 is the previous version the diff compares against. */
function mockVersions() {
  vi.mocked(useSkillVersions).mockReturnValue({
    data: {
      pages: [
        {
          data: [
            versionRow(3, "hash-head"),
            versionRow(2, "hash-two"),
            versionRow(1, "hash-one"),
          ],
        },
      ],
    },
    isPending: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

function mockVersionDetails(
  details: Record<number, ReturnType<typeof versionDetail>>,
) {
  vi.mocked(useSkillVersion).mockImplementation(((
    _id: string | null,
    version: number | null,
  ) => ({
    data: version === null ? null : (details[version] ?? null),
    isPending: false,
  })) as never);
}

function renderDialog() {
  return render(
    <SkillVersionHistoryDialog
      skillId="skill-1"
      open
      onOpenChange={() => {}}
    />,
  );
}

describe("SkillVersionHistoryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(useMissingPermissions).mockReturnValue({});
    vi.mocked(useRestoreSkillVersion).mockReturnValue({
      mutateAsync,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
    vi.mocked(useResetSkill).mockReturnValue({
      mutateAsync: resetAsync,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
    mockSkill();
    mockVersions();
    mockVersionDetails({
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
      }),
      2: versionDetail({
        version: 2,
        content: OLD_BODY,
        contentHash: "hash-two",
      }),
    });
  });

  it("opens on the head version and marks it as current", () => {
    renderDialog();

    expect(
      screen.getByRole("heading", { name: "Version 3" }),
    ).toBeInTheDocument();
    const headRow = screen.getByRole("button", { name: /v3/ });
    expect(within(headRow).getByText("Current")).toBeInTheDocument();
  });

  it("cannot restore the version the skill is already on", () => {
    renderDialog();

    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
  });

  it("diffs a selected version against its predecessor", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));

    expect(screen.getByTestId("diff-original")).toHaveTextContent("old body");
    expect(screen.getByTestId("diff-modified")).toHaveTextContent("head body");
  });

  it("enables restore for an older version", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));

    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeEnabled();
  });

  it("passes the previewed head to the mutation so a concurrent edit is caught", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore version 2" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      skillId: "skill-1",
      version: 2,
      expectedHeadVersion: 3,
      headContentHash: "hash-head",
    });
  });

  it("says a restore leaves unversioned settings alone", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );

    expect(screen.getByText(/not\s+versioned/)).toHaveTextContent(
      "the name, description, and other frontmatter fields are not versioned",
    );
  });

  it("blocks restoring a GitHub-synced skill and says why", async () => {
    const user = userEvent.setup();
    mockSkill({ sourceType: "github", githubSyncInterval: "1h" });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));

    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
    expect(screen.getByText(/synced from GitHub/)).toBeInTheDocument();
  });

  it("offers reset to default only for built-in skills", () => {
    const { unmount } = renderDialog();
    expect(
      screen.queryByRole("button", { name: /Reset to default/ }),
    ).not.toBeInTheDocument();
    unmount();

    mockSkill({ sourceType: "built_in" });
    renderDialog();
    expect(
      screen.getByRole("button", { name: /Reset to default/ }),
    ).toBeInTheDocument();
  });

  it("lists a version's changed resource files alongside SKILL.md", async () => {
    const user = userEvent.setup();
    mockVersionDetails({
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
        files: [
          file("scripts/extract.py", "new"),
          file("scripts/keep.py", "s"),
        ],
      }),
      2: versionDetail({
        version: 2,
        content: OLD_BODY,
        contentHash: "hash-two",
        files: [
          file("scripts/extract.py", "old"),
          file("scripts/keep.py", "s"),
        ],
      }),
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));

    expect(
      screen.getByRole("button", { name: /scripts\/extract\.py/ }),
    ).toBeInTheDocument();
    // an untouched file is not part of the change set
    expect(
      screen.queryByRole("button", { name: /scripts\/keep\.py/ }),
    ).not.toBeInTheDocument();
  });

  it("counts only what actually changed, not SKILL.md by default", async () => {
    const user = userEvent.setup();
    mockVersionDetails({
      // v3 leaves SKILL.md alone and only touches one script
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
        files: [file("scripts/extract.py", "new")],
      }),
      2: versionDetail({
        version: 2,
        content: HEAD_BODY,
        contentHash: "hash-two",
        files: [file("scripts/extract.py", "old")],
      }),
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));

    expect(screen.getByRole("tab", { name: /Changes/ })).toHaveTextContent(
      "Changes(1)",
    );
  });

  it("diffs a resource file when its chip is chosen", async () => {
    const user = userEvent.setup();
    mockVersionDetails({
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
        files: [file("scripts/extract.py", "new script")],
      }),
      2: versionDetail({
        version: 2,
        content: OLD_BODY,
        contentHash: "hash-two",
        files: [file("scripts/extract.py", "old script")],
      }),
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));
    await user.click(
      screen.getByRole("button", { name: /scripts\/extract\.py/ }),
    );

    expect(screen.getByTestId("diff-original")).toHaveTextContent("old script");
    expect(screen.getByTestId("diff-modified")).toHaveTextContent("new script");
  });
});
