import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/skills/skill.query", () => ({
  useSkill: vi.fn(),
  useUpdateSkill: vi.fn(),
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
}));
vi.mock("../_parts/skill-version-history-dialog", () => ({
  SkillVersionHistoryDialog: () => null,
}));
vi.mock("../_parts/skill-usage-dialog", () => ({
  SkillUsageDialog: () => null,
}));
vi.mock("../_parts/delete-skill-dialog", () => ({
  DeleteSkillDialog: () => null,
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useHasPermissions,
  useMissingPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useSkill, useUpdateSkill } from "@/lib/skills/skill.query";
import { SkillDetailPage } from "./page.client";

const updateMutateAsync = vi.fn();

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
      authorId: "user-1",
      files: [],
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

const save = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Save skill" }));
};

describe("SkillDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMutateAsync.mockResolvedValue({ id: "skill-1", latestVersion: 8 });
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
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
    vi.mocked(useUpdateSkill).mockReturnValue({
      mutateAsync: updateMutateAsync,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
    mockSkill();
  });

  it("shows the skill's name and its content editor", () => {
    renderPage();

    expect(
      screen.getByRole("heading", { name: /pdf-tools/ }),
    ).toBeInTheDocument();
    expect(
      (
        screen.getByRole("textbox", {
          name: "File contents",
        }) as HTMLTextAreaElement
      ).value,
    ).toContain("Use pdftotext -layout.");
    // Nothing to save until something changes.
    expect(screen.getByRole("button", { name: "Save skill" })).toBeDisabled();
  });

  it("anchors a save to the version the page was loaded from", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", { name: "File contents" }),
      " Prefer -raw for tables.",
    );
    await save();

    // `files` is a whole-set replacement built from that read, so without the
    // anchor this save would bury anything written since it was loaded.
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "skill-1",
        body: expect.objectContaining({ baseVersion: 7, files: [] }),
      }),
    );
  });

  it("keeps unsaved edits when a background refetch lands under them", async () => {
    const { rerender } = renderPage();
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", { name: "File contents" }),
      " Prefer -raw for tables.",
    );

    // A window-focus refetch, a sync pull, or another tab's save: same id,
    // fresh object, head moved on.
    mockSkill({ latestVersion: 9, content: "Someone else rewrote this." });
    rerender(<SkillDetailPage id="skill-1" />);

    const editor = screen.getByRole("textbox", {
      name: "File contents",
    }) as HTMLTextAreaElement;
    expect(editor.value).toContain("Prefer -raw for tables.");
    expect(editor.value).not.toContain("Someone else rewrote this.");

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
    const editor = () =>
      screen.getByRole("textbox", {
        name: "File contents",
      }) as HTMLTextAreaElement;
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

    const editor = screen.getByRole("textbox", {
      name: "File contents",
    }) as HTMLTextAreaElement;
    expect(editor.value).toContain("Someone else rewrote this.");

    const user = userEvent.setup();
    await user.type(editor, " And a note.");
    await save();
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ baseVersion: 9 }),
      }),
    );
  });

  it("keeps the content editor mounted while the Access tab is open", async () => {
    renderPage("tab=access");

    // Its file tree, open file and trash bin are the editor's own state; a
    // trip to Access is not a decision to drop them.
    expect(
      screen.getByRole("textbox", { name: "File contents" }),
    ).toBeInTheDocument();
  });

  it("does not anchor a synced skill, whose own pulls move the head", async () => {
    mockSkill({ githubSyncInterval: "1h", sourceType: "github" });
    renderPage("tab=access");
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

  it("locks the content of a synced skill", () => {
    mockSkill({ githubSyncInterval: "1h", sourceType: "github" });
    renderPage();

    expect(screen.getByTestId("github-sync-panel")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "File contents" }),
    ).toHaveAttribute("readonly");
  });

  it("shows a not-found state for a deleted or inaccessible skill", () => {
    vi.mocked(useSkill).mockReturnValue({
      data: null,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    renderPage();

    expect(screen.getByText("Skill not found")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save skill" }),
    ).not.toBeInTheDocument();
  });
});
