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
  sourceCommit: null,
  createdAt: "2026-08-03T10:00:00.000Z",
});

const versionDetail = ({
  version,
  content,
  contentHash,
  sourceCommit = null,
  files = [],
}: {
  version: number;
  content: string;
  contentHash: string;
  /** Set only on versions a GitHub import or sync produced. */
  sourceCommit?: string | null;
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
  sourceCommit,
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

/** Switch the pane from the whole version to the set of files that moved. */
const openChanges = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /^Changes/ }));

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
    // `clearAllMocks` leaves implementations in place, so the mutation is
    // re-stubbed here rather than inheriting whatever the last test set. Null
    // is the "nothing was written" resolution; success cases override it.
    mutateAsync.mockResolvedValue(null);
    resetAsync.mockResolvedValue({ id: "skill-1" });
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

  it("links a synced version to the upstream tree it was pulled from", () => {
    mockSkill({
      sourceType: "github",
      sourceRef: "eph5xx/tiebreaker@main:skills/tiebreaker",
    });
    mockVersionDetails({
      3: versionDetail({
        version: 3,
        content: HEAD_BODY,
        contentHash: "hash-head",
        sourceCommit: "6500e3659dd2a3ceeb745b03eb6ab2d169d4e1e7",
      }),
    });
    renderDialog();

    const link = screen.getByRole("link", { name: /6500e36/ });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/eph5xx/tiebreaker/tree/6500e3659dd2a3ceeb745b03eb6ab2d169d4e1e7/skills/tiebreaker",
    );
  });

  it("shows no source link for a version that was authored here", () => {
    // The default skill is `manual` and its versions carry no commit: an
    // authored edit has no upstream tree to point at.
    renderDialog();

    expect(screen.queryByRole("link", { name: /hash-he/ })).toBeNull();
    // the content hash is still there; it is simply not a link to anywhere.
    expect(screen.getAllByText("hash-he").length).toBeGreaterThan(0);
  });

  it("cannot restore the version the skill is already on", () => {
    renderDialog();

    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
  });

  it("opens on the whole version, read as files rather than as a comparison", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));

    expect(screen.getByTestId("editor")).toHaveTextContent("head body");
    expect(screen.queryByTestId("diff")).not.toBeInTheDocument();
  });

  it("diffs a version against its predecessor under Changes", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));
    await openChanges(user);

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
      /The 1 file the skill has now that version 2 does not is removed/,
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

  it("diffs a resource file when its row is chosen under Changes", async () => {
    const user = userEvent.setup();
    mockChangedScript();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));
    await openChanges(user);
    await user.click(screen.getByRole("button", { name: "extract.py" }));

    expect(screen.getByTestId("diff-original")).toHaveTextContent("old script");
    expect(screen.getByTestId("diff-modified")).toHaveTextContent("new script");
  });

  it("reads a changed file whole under All files", async () => {
    const user = userEvent.setup();
    mockChangedScript();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));
    await user.click(screen.getByRole("button", { name: "extract.py" }));

    // the file as this version stores it, not as a comparison — the reason the
    // switcher decides the rendering and not just the listing
    expect(screen.getByTestId("editor")).toHaveTextContent("new script");
    expect(screen.queryByTestId("diff")).not.toBeInTheDocument();
  });

  it("lists only what moved under Changes", async () => {
    const user = userEvent.setup();
    mockChangedScript();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));
    await openChanges(user);

    expect(
      screen.getByRole("button", { name: "extract.py" }),
    ).toBeInTheDocument();
    // an untouched file has no place in a list of changes, and neither would an
    // untouched body — this version's did move, so SKILL.md stays
    expect(
      screen.queryByRole("button", { name: "keep.py" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "SKILL.md" }),
    ).toBeInTheDocument();
  });

  it("drops an unchanged body from the change set", async () => {
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
        // same body, so only the script moved
        content: HEAD_BODY,
        contentHash: "hash-two",
        files: [file("scripts/extract.py", "old script")],
      }),
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));
    await openChanges(user);

    expect(
      screen.queryByRole("button", { name: "SKILL.md" }),
    ).not.toBeInTheDocument();
    // the selection falls through to the first row that survived rather than
    // leaving the pane on a file this list no longer holds
    expect(screen.getByTestId("diff-modified")).toHaveTextContent("new script");
  });

  it("keeps the chosen view across versions", async () => {
    const user = userEvent.setup();
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
      1: versionDetail({
        version: 1,
        content: "first body",
        contentHash: "hash-one",
      }),
    });
    renderDialog();

    await openChanges(user);
    await user.click(screen.getByRole("button", { name: /v2/ }));

    // whoever came to read diffs keeps reading diffs
    expect(screen.getByTestId("diff-original")).toHaveTextContent("first body");
  });

  it("cannot compare the earliest version, and says why", async () => {
    const user = userEvent.setup();
    mockVersionDetails({
      1: versionDetail({
        version: 1,
        content: OLD_BODY,
        contentHash: "hash-one",
      }),
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v1/ }));

    // offering the comparison would promise one nothing can produce
    const changes = screen.getByRole("button", { name: /^Changes/ });
    expect(changes).toBeDisabled();
    await user.hover(changes.parentElement as HTMLElement);
    // radix renders the content and a screen-reader copy of it
    expect(await screen.findAllByText(/earliest version/)).not.toHaveLength(0);
  });

  it("cannot compare against a baseline that failed to load", async () => {
    const user = userEvent.setup();
    mockFailedBaseline();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v3/ }));

    expect(screen.getByRole("button", { name: /^Changes/ })).toBeDisabled();
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
      screen.getByRole("button", { name: "SKILL.md" }).closest("li"),
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

  it("offers reset to default only for a skill the app ships", () => {
    const { unmount } = renderDialog();

    // a manual skill has no shipped version to go back to
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

  it("resets a built-in skill to the shipped version once confirmed", async () => {
    const user = userEvent.setup();
    mockSkill({ sourceType: "built_in" });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Reset to default/ }));
    await user.click(
      within(screen.getByRole("dialog", { name: /Reset skill/ })).getByRole(
        "button",
        { name: "Reset to default" },
      ),
    );

    expect(resetAsync).toHaveBeenCalledWith("skill-1");
  });

  it("lists a version once when a page boundary re-returns it", () => {
    // Pages are read by offset, so a version created between the two loads
    // shifts every row down and page two repeats the row page one ended on.
    vi.mocked(useSkillVersions).mockReturnValue({
      data: {
        pages: [
          { data: [versionRow(3, "hash-head"), versionRow(2, "hash-two")] },
          { data: [versionRow(2, "hash-two"), versionRow(1, "hash-one")] },
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
    renderDialog();

    expect(screen.getAllByRole("button", { name: /^v2/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^v1/ })).toBeInTheDocument();
  });

  it("loads older versions on request", async () => {
    const user = userEvent.setup();
    const fetchNextPage = vi.fn();
    vi.mocked(useSkillVersions).mockReturnValue({
      data: { pages: [{ data: [versionRow(3, "hash-head")] }] },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    renderDialog();

    await user.click(
      screen.getByRole("button", { name: "Load older versions" }),
    );

    expect(fetchNextPage).toHaveBeenCalled();
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

  it("does not call a skill versionless while its head is still unknown", () => {
    // on open both reads are in flight, so nothing yet names a head version
    vi.mocked(useSkill).mockReturnValue({
      data: undefined,
      isPending: true,
      refetch: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(useSkillVersions).mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      refetch: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    renderDialog();

    // every skill has at least version 1, so "no versions yet" is never a true
    // reading — in flight or failed, it is one of those two instead
    expect(screen.queryByText(/no recorded versions/i)).not.toBeInTheDocument();
    expect(screen.getByText("Loading version...")).toBeInTheDocument();
  });

  it("offers a retry when the skill itself cannot be read", async () => {
    const user = userEvent.setup();
    const refetchSkill = vi.fn();
    const refetchVersions = vi.fn();
    // the skill 404s and the list fails, so no read names a head version
    vi.mocked(useSkill).mockReturnValue({
      data: null,
      isPending: false,
      refetch: refetchSkill,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    mockVersionsError(refetchVersions);
    renderDialog();

    expect(screen.queryByText(/no recorded versions/i)).not.toBeInTheDocument();
    const failure = screen
      .getByText("Could not load this skill.")
      .closest("div");
    await user.click(
      within(failure as HTMLElement).getByRole("button", { name: "Retry" }),
    );

    expect(refetchSkill).toHaveBeenCalled();
    expect(refetchVersions).toHaveBeenCalled();
  });

  it("shows a version without waiting on the baseline, and without guessing", () => {
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

    // the version asked for is already in hand, so it is rendered rather than
    // held back behind a second fetch — just not annotated until that lands
    expect(
      screen.getByRole("button", { name: "extract.py" }).closest("li"),
    ).not.toHaveTextContent(/added|removed|changed/);
    expect(screen.getByTestId("editor")).toHaveTextContent(HEAD_BODY);
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

  it("lists a version whose predecessor is gone without claiming what moved", async () => {
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

    // there is one rule: no baseline, no badges — a 404 predecessor supports
    // "added" no better than a failed one does
    expect(
      screen.getByRole("button", { name: "SKILL.md" }).closest("li"),
    ).not.toHaveTextContent(/added|removed|changed/);
    expect(
      screen.getByRole("button", { name: "extract.py" }).closest("li"),
    ).not.toHaveTextContent(/added|removed|changed/);
  });

  it("lists the earliest version on its own, having nothing to compare against", async () => {
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

    // version 1 has no predecessor, so it is shown rather than annotated, and
    // there is no failure to report either
    expect(
      screen.getByRole("button", { name: "extract.py" }).closest("li"),
    ).not.toHaveTextContent(/added|removed|changed/);
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(screen.getByTestId("editor")).toHaveTextContent(OLD_BODY);
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
