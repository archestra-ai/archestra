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
      // The skill as it stands today. A restore replaces this set wholesale, so
      // the confirmation reads it to say what a restore would drop.
      files: [],
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
    isError: false,
    refetch: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

/** The history list failed outright — no pages, and not still loading. */
function mockVersionsError(refetch = vi.fn()) {
  vi.mocked(useSkillVersions).mockReturnValue({
    data: undefined,
    isPending: false,
    isError: true,
    refetch,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

/**
 * Versions listed here have settled: a detail object is a hit, `null` is the
 * 404 a pruned version answers, and `"error"` is a fetch that failed outright.
 * Anything absent is still in flight, which is how the dialog tells "not known
 * yet" from "known to be gone" and from "could not be read".
 */
function mockVersionDetails(
  details: Record<number, ReturnType<typeof versionDetail> | null | "error">,
  refetch = vi.fn(),
) {
  vi.mocked(useSkillVersion).mockImplementation(((
    _id: string | null,
    version: number | null,
  ) => {
    const entry = version === null ? null : details[version];
    return {
      data: entry === "error" ? undefined : (entry ?? null),
      isPending: !(version !== null && version in details),
      // A 404 resolves as a settled `null`, so only an outright failure is an
      // error — that is the whole distinction the dialog reads.
      isError: entry === "error",
      refetch,
    };
  }) as never);
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
    // `clearAllMocks` leaves implementations in place, so both mutations are
    // re-stubbed here rather than inheriting whatever the last test set. Null
    // is the "nothing was written" resolution; success cases override it.
    mutateAsync.mockResolvedValue(null);
    resetAsync.mockResolvedValue(null);
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
      baseVersion: 3,
    });
  });

  it("warns that a restore drops files the skill has today", async () => {
    const user = userEvent.setup();
    // The skill grew a second script after v2; restoring v2 replaces the whole
    // file set, so that script goes with it.
    mockSkill({
      files: [file("scripts/extract.py", "new"), file("scripts/added.py", "x")],
    });
    mockVersionDetails({
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
        files: [file("scripts/extract.py", "new")],
      }),
      2: versionDetail({
        version: 2,
        content: OLD_BODY,
        contentHash: "hash-two",
        files: [file("scripts/extract.py", "old")],
      }),
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );

    expect(
      screen.getByRole("dialog", { name: /Restore version 2/ }),
    ).toHaveTextContent(
      /The 1 resource file the skill has today that version 2 does not is removed/,
    );
  });

  it("does not mention removals when the restore drops nothing", async () => {
    const user = userEvent.setup();
    mockSkill({ files: [file("scripts/extract.py", "new")] });
    mockVersionDetails({
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
        files: [file("scripts/extract.py", "new")],
      }),
      2: versionDetail({
        version: 2,
        content: OLD_BODY,
        contentHash: "hash-two",
        files: [file("scripts/extract.py", "old")],
      }),
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );

    expect(
      screen.getByRole("dialog", { name: /Restore version 2/ }),
    ).not.toHaveTextContent(/is removed|are removed/);
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

  it("lists the whole version, nested under its folders, badging what moved", async () => {
    const user = userEvent.setup();
    mockChangedScript();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));

    expect(
      screen.getByRole("button", { name: "scripts/" }),
    ).toBeInTheDocument();
    // both files belong to the version; only the edited one carries a badge
    const changed = screen.getByRole("button", { name: "extract.py" });
    const untouched = screen.getByRole("button", { name: "keep.py" });
    expect(changed.closest("li")).toHaveTextContent("changed");
    expect(untouched.closest("li")).not.toHaveTextContent(
      /added|removed|changed/,
    );
  });

  it("diffs a resource file when its row is chosen", async () => {
    const user = userEvent.setup();
    mockChangedScript();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));
    await user.click(screen.getByRole("button", { name: "extract.py" }));

    expect(screen.getByTestId("diff-original")).toHaveTextContent("old script");
    expect(screen.getByTestId("diff-modified")).toHaveTextContent("new script");
  });

  it("opens an unchanged file as itself rather than as an empty diff", async () => {
    const user = userEvent.setup();
    mockChangedScript();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));
    await user.click(screen.getByRole("button", { name: "keep.py" }));

    // a diff of identical bytes collapses to nothing, so the file is shown whole
    expect(screen.getByTestId("editor")).toHaveTextContent("same");
    expect(screen.queryByTestId("diff")).not.toBeInTheDocument();
  });

  it("keeps the confirmation open when the restore does not go through", async () => {
    const user = userEvent.setup();
    // A handled failure (moved head, identical content, rejected write) resolves
    // to null, and its toast needs the dialog it refers to still on screen.
    mutateAsync.mockResolvedValue(null);
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore version 2" }));

    expect(
      screen.getByRole("button", { name: "Restore version 2" }),
    ).toBeInTheDocument();
  });

  it("shows a version whose predecessor failed to load, without waiting on it", async () => {
    const user = userEvent.setup();
    mockFailedBaseline();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));

    // waiting on a settled failure would hang the comparison forever
    expect(screen.queryByText(/^Comparing with/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "extract.py" }),
    ).toBeInTheDocument();
  });

  it("does not call a version added when the baseline could not be read", async () => {
    const user = userEvent.setup();
    mockFailedBaseline();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));

    // an empty baseline is what a pruned predecessor and a failed fetch have in
    // common; only the first of them means the files are new
    expect(
      screen.getByRole("button", { name: "extract.py" }).closest("li"),
    ).not.toHaveTextContent(/added|removed|changed/);
    expect(
      screen.getByRole("button", { name: "Instructions" }).closest("li"),
    ).not.toHaveTextContent(/added|removed|changed/);
    expect(
      screen.getByText(/Version 2 could not be loaded/),
    ).toBeInTheDocument();
  });

  it("opens a file whole when there is no baseline to diff it against", async () => {
    const user = userEvent.setup();
    mockFailedBaseline();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));
    await user.click(screen.getByRole("button", { name: "extract.py" }));

    // diffing against the empty string would draw the file as wholly new
    expect(screen.getByTestId("editor")).toHaveTextContent("new");
    expect(screen.queryByTestId("diff")).not.toBeInTheDocument();
  });

  it("offers a retry for a baseline that failed", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mockFailedBaseline(refetch);
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(refetch).toHaveBeenCalled();
  });

  it("offers a retry instead of calling a version gone when it fails to load", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    // The selected version itself failed — not its baseline. A pruned version
    // answers 404 and settles as `null`; this one was never read at all.
    mockVersionDetails({ 3: "error" }, refetch);
    renderDialog();

    expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Version 3 could not be loaded/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("says the manifest row holds the body alone, not the editor's SKILL.md", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));

    // the editor's SKILL.md carries frontmatter this document does not, so the
    // pane says so rather than letting the two read as the same file
    expect(screen.getByText(/are not versioned/)).toBeInTheDocument();
  });

  it("offers a retry instead of claiming a skill has no versions", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mockVersionsError(refetch);
    renderDialog();

    expect(screen.queryByText("No versions")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(refetch).toHaveBeenCalled();
  });

  it("does not annotate a version before its baseline settles", () => {
    // only the selected version has arrived; its predecessor is still in flight
    mockVersionDetails({
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
        files: [file("scripts/extract.py", "new")],
      }),
    });
    renderDialog();

    // annotating now would guess; the version is shown once there is a baseline
    expect(screen.getByText("Comparing with version 2...")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "extract.py" }),
    ).not.toBeInTheDocument();
  });

  it("reads a file this version stores as text, whatever the last one stored", async () => {
    const user = userEvent.setup();
    mockVersionDetails({
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
        files: [file("assets/logo.svg", "<svg />")],
      }),
      2: versionDetail({
        version: 2,
        content: HEAD_BODY,
        contentHash: "hash-two",
        files: [
          { ...file("assets/logo.svg", "PHN2ZyAvPg=="), encoding: "base64" },
        ],
      }),
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: "logo.svg" }));

    // the previous version's encoding says nothing about the copy on screen
    expect(screen.getByTestId("editor")).toHaveTextContent("<svg />");
  });

  it("reads a version whose predecessor is gone as newly added", async () => {
    const user = userEvent.setup();
    mockVersionDetails({
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
        files: [file("scripts/extract.py", "new")],
      }),
      // v2 answers 404 — a settled absence, not a slow response
      2: null,
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));

    expect(screen.queryByText(/^Comparing with/)).not.toBeInTheDocument();
    // with no baseline the whole version reads as added, manifest included
    expect(
      screen.getByRole("button", { name: "Instructions" }).closest("li"),
    ).toHaveTextContent("added");
    expect(
      screen.getByRole("button", { name: "extract.py" }).closest("li"),
    ).toHaveTextContent("added");
  });

  it("reads the earliest version as newly added, having nothing to diff against", async () => {
    const user = userEvent.setup();
    mockVersionDetails({
      1: versionDetail({
        version: 1,
        content: OLD_BODY,
        contentHash: "hash-one",
        files: [file("scripts/extract.py", "first")],
      }),
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v1/ }));

    // version 1 has no predecessor to wait for, so it never blocks on one
    expect(screen.queryByText(/^Comparing with/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "extract.py" }).closest("li"),
    ).toHaveTextContent("added");
  });
});

/** v3 has arrived; the v2 it would be compared against failed outright. */
function mockFailedBaseline(refetch = vi.fn()) {
  mockVersionDetails(
    {
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
        files: [file("scripts/extract.py", "new")],
      }),
      2: "error",
    },
    refetch,
  );
}

/** v3 rewrites one script and leaves another alone. */
function mockChangedScript() {
  mockVersionDetails({
    3: versionDetail({
      version: 3,
      content: HEAD_BODY,
      contentHash: "hash-head",
      files: [
        file("scripts/extract.py", "new script"),
        file("scripts/keep.py", "same"),
      ],
    }),
    2: versionDetail({
      version: 2,
      content: OLD_BODY,
      contentHash: "hash-two",
      files: [
        file("scripts/extract.py", "old script"),
        file("scripts/keep.py", "same"),
      ],
    }),
  });
}
