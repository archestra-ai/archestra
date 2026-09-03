import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
// The scope check behind the save row asks which teams the caller belongs to.
vi.mock("@/lib/teams/team.query");
// Monaco does not render in jsdom; the canonical mock is a textarea.
vi.mock("@/components/editor");
vi.mock("@/lib/skills/skill.query", () => ({
  useSkill: vi.fn(),
  useUpdateSkill: vi.fn(),
}));
vi.mock("../_parts/skill-version-history-dialog", () => ({
  SkillVersionHistoryDialog: () => null,
}));
vi.mock("../_parts/skill-usage-panel", () => ({
  SkillUsagePanel: () => <div data-testid="skill-usage-panel" />,
}));
vi.mock("../_parts/delete-skill-dialog", () => ({
  DeleteSkillDialog: () => null,
}));
// Pulls its options over the network; the test drives it through a stub that
// flips the scope, which is all a save cares about.
vi.mock("../_parts/skill-access-fields", () => ({
  SkillAccessFields: ({
    onChange,
  }: {
    onChange: (patch: { scope: string }) => void;
  }) => (
    <button type="button" onClick={() => onChange({ scope: "org" })}>
      Share with organization
    </button>
  ),
}));
vi.mock("../_parts/github-sync-panel", () => ({
  GithubSyncPanel: () => <div data-testid="github-sync-panel" />,
  GithubSnapshotNotice: () => <div data-testid="github-snapshot-notice" />,
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useHasPermissions,
  useMissingPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useSkill, useUpdateSkill } from "@/lib/skills/skill.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { SkillDetailPage } from "./page.client";

const updateMutateAsync = vi.fn();
const push = vi.fn();
const replace = vi.fn();

/** The skill as loaded into the page, sitting at version 7. */
function mockSkill(overrides: Record<string, unknown> = {}) {
  vi.mocked(useSkill).mockReturnValue({
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
      content: "Use pdftotext -layout.",
      latestVersion: 7,
      scope: "personal",
      sourceType: "manual",
      sourceRef: null,
      githubSyncInterval: null,
      githubSyncRef: null,
      lastSyncedAt: null,
      lastSyncError: null,
      usageCount: 3,
      lastUsedAt: "2026-08-18T10:00:00.000Z",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-18T09:00:00.000Z",
      authorId: "user-1",
      files: [{ path: "notes.md", content: "# notes", encoding: "utf8" }],
      teams: [],
      users: [],
      environments: [],
      ...overrides,
    },
    isPending: false,
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

function renderPage(searchParams = "") {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(searchParams) as ReturnType<typeof useSearchParams>,
  );
  return render(<SkillDetailPage id="skill-1" />);
}

const editor = () =>
  screen.getByRole("textbox", {
    name: "File contents",
  }) as HTMLTextAreaElement;

const save = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
};

describe("SkillDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMutateAsync.mockResolvedValue({ id: "skill-1", latestVersion: 8 });
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/skills/skill-1");
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
      // biome-ignore lint/suspicious/noExplicitAny: partial session is enough
    } as any);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(useMissingPermissions).mockReturnValue({});
    vi.mocked(useMyTeams).mockReturnValue({
      data: [],
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(useUpdateSkill).mockReturnValue({
      mutateAsync: updateMutateAsync,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
    mockSkill();
  });

  it("is the skill's settings rather than a read-only view of them", () => {
    renderPage();

    expect(
      screen.getByRole("heading", { name: /pdf-tools/ }),
    ).toBeInTheDocument();
    // Name and description are fields, not facts, and the manifest is editable
    // right below them.
    expect(screen.getByLabelText("Skill name")).toHaveValue("pdf-tools");
    expect(screen.getByLabelText("Description")).toHaveValue("Work with PDFs.");
    expect(editor().value).toContain("Use pdftotext -layout.");
    expect(editor()).not.toHaveAttribute("readonly");
    expect(screen.getByText("notes.md")).toBeInTheDocument();

    // Who can use it is the end of the same page, not a second route.
    expect(
      screen.getByRole("button", { name: "Share with organization" }),
    ).toBeInTheDocument();

    // Nothing sends the reader anywhere to edit: this is where editing happens.
    expect(screen.queryByRole("link", { name: /^Edit\b/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Configuration/ })).toBeNull();
    // Clean: there is nothing to write yet.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("writes the name and description fields back into the manifest", async () => {
    renderPage();
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText("Skill name"));
    await user.type(screen.getByLabelText("Skill name"), "pdf-kit");

    // The manifest is the source of truth, so the field edit lands in it —
    // otherwise the two would disagree the moment someone scrolled down.
    expect(editor().value).toContain('name: "pdf-kit"');
    await save();
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "skill-1",
        body: expect.objectContaining({
          content: expect.stringContaining('name: "pdf-kit"'),
        }),
      }),
    );
  });

  it("saves in place, without leaving the skill's page", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.type(editor(), " Prefer -raw for tables.");
    expect(
      screen.getByRole("button", { name: "Discard changes" }),
    ).toBeInTheDocument();

    await save();

    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining("Prefer -raw for tables."),
        }),
      }),
    );
    // The page it saved from is the page it stays on.
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("saves a visibility change made at the bottom of the same page", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Share with organization" }),
    );
    await save();

    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ scope: "org" }),
      }),
    );
  });

  it("anchors a save to the version the page was loaded from", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.type(editor(), " Prefer -raw for tables.");
    await save();

    // `files` is a whole-set replacement built from that read, so without the
    // anchor this save would bury anything written since it was loaded.
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ baseVersion: 7 }),
      }),
    );
  });

  it("keeps unsaved edits when a background refetch lands under them", async () => {
    const { rerender } = renderPage();
    const user = userEvent.setup();
    await user.type(editor(), " Prefer -raw for tables.");

    // A window-focus refetch, a sync pull, or another tab's save: same id,
    // fresh object, head moved on.
    mockSkill({ latestVersion: 9, content: "Someone else rewrote this." });
    rerender(<SkillDetailPage id="skill-1" />);

    expect(editor().value).toContain("Prefer -raw for tables.");
    expect(editor().value).not.toContain("Someone else rewrote this.");

    // Still anchored to the head the draft was composed against, so the
    // backend rejects this save rather than burying version 9.
    await save();
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ baseVersion: 7 }),
      }),
    );
  });

  it("does not let the stale read behind a save walk the anchor backwards", async () => {
    const { rerender } = renderPage();
    const user = userEvent.setup();
    await user.type(editor(), " Prefer -raw for tables.");
    await save();

    // A save invalidates the skill and the refetch lands a moment later, so
    // for that window the cached skill is still the pre-save one.
    rerender(<SkillDetailPage id="skill-1" />);
    expect(editor().value).toContain("Prefer -raw for tables.");

    // The next save has to anchor to the head this page just wrote (8), not
    // the version the stale read still reports (7) — which the backend would
    // reject as a conflict against the page's own write.
    await user.type(editor(), " And one more.");
    await save();
    expect(updateMutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ baseVersion: 8 }),
      }),
    );
  });

  it("adopts a newer read when the draft is untouched", async () => {
    const { rerender } = renderPage();

    mockSkill({ latestVersion: 9, content: "Someone else rewrote this." });
    rerender(<SkillDetailPage id="skill-1" />);
    expect(editor().value).toContain("Someone else rewrote this.");

    const user = userEvent.setup();
    await user.type(editor(), " And a note.");
    await save();
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ baseVersion: 9 }),
      }),
    );
  });

  it("locks a synced skill's content while its access stays editable", async () => {
    mockSkill({ githubSyncInterval: "1h", sourceType: "github" });
    renderPage();

    expect(screen.getByTestId("github-sync-panel")).toBeInTheDocument();
    expect(editor()).toHaveAttribute("readonly");

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Share with organization" }),
    );
    await save();

    // The save carries no files and the backend refuses any content change, so
    // there is nothing to bury — anchoring would only let the sync worker
    // reject an unrelated scope edit.
    const body = updateMutateAsync.mock.calls[0][0].body;
    expect(body).toMatchObject({ scope: "org" });
    expect(body).not.toHaveProperty("baseVersion");
    expect(body).not.toHaveProperty("files");
  });

  it("offers no save row to someone who may not change this skill", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    renderPage();

    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(
      screen.getByText(/view this skill's configuration but not change it/i),
    ).toBeInTheDocument();
    expect(editor()).toHaveAttribute("readonly");
  });

  it("keeps usage a section of the same page, including its older URL", () => {
    const { unmount } = renderPage("section=usage");
    expect(screen.getByTestId("skill-usage-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    unmount();

    // `?tab=usage` is the shape this view shipped with and is still pasted
    // around, so it has to keep landing on the same section.
    renderPage("tab=usage");
    expect(screen.getByTestId("skill-usage-panel")).toBeInTheDocument();
  });

  it("shows a not-found state for a deleted or inaccessible skill", () => {
    vi.mocked(useSkill).mockReturnValue({
      data: null,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    renderPage();

    expect(screen.getByText("Skill not found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });
});
