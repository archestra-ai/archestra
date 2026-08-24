import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
// The scope check behind Edit/Delete asks which teams the caller belongs to.
vi.mock("@/lib/teams/team.query");
// Monaco does not render in jsdom; the canonical mock is a textarea.
vi.mock("@/components/editor");
vi.mock("@/lib/skills/skill.query", () => ({
  useSkill: vi.fn(),
}));
vi.mock("../_parts/skill-version-history-dialog", () => ({
  SkillVersionHistoryDialog: () => null,
}));
vi.mock("../_parts/skill-usage-panel", () => ({
  SkillUsagePanel: () => null,
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
import { useSkill } from "@/lib/skills/skill.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { SkillDetailPage } from "./page.client";

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

function section(name: string) {
  // Every card title is one rank; cards are siblings, not a hierarchy.
  const heading = screen.getByRole("heading", { name });
  const root = heading.closest("section");
  if (!root) throw new Error(`No section around "${name}"`);
  return within(root);
}

describe("SkillDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/skills/skill-1");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
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
    mockSkill();
  });

  it("keeps content primary and reveals access/source facts from a collapsed section", async () => {
    const user = userEvent.setup();
    render(<SkillDetailPage id="skill-1" />);

    expect(
      screen.getByRole("heading", { name: /pdf-tools/ }),
    ).toBeInTheDocument();

    // The content, in the wizard's own editor, read-only — with its files.
    const content = section("Instructions and files");
    const editor = content.getByRole("textbox", {
      name: "File contents",
    }) as HTMLTextAreaElement;
    expect(editor.value).toContain("Use pdftotext -layout.");
    expect(editor).toHaveAttribute("readonly");
    expect(content.getByText("notes.md")).toBeInTheDocument();
    // No save anywhere: editing goes through the wizard.
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();

    const overview = screen.getByRole("button", { name: "Access and source" });
    expect(overview).toHaveAttribute("aria-expanded", "false");
    // Collapsed: the heading names the section, but none of its facts show.
    expect(screen.queryByText("All environments")).toBeNull();

    await user.click(overview);
    expect(overview).toHaveAttribute("aria-expanded", "true");
    const access = section("Access and source");
    expect(access.getByText("All environments")).toBeInTheDocument();
    expect(screen.queryByText("Accessible to")).toBeNull();
    expect(access.getByText("Written in Archestra")).toBeInTheDocument();
    expect(access.getByText("v7")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Details" })).toBeNull();
    expect(screen.queryByText("skill-1")).toBeNull();
  });

  it("keeps a single Edit in the header instead of repeating it on cards", () => {
    render(<SkillDetailPage id="skill-1" />);

    const edits = screen.getAllByRole("link", { name: /^Edit\b/ });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toHaveAttribute("href", "/skills/skill-1/edit");
    expect(
      section("Instructions and files").queryByRole("link", {
        name: /^Edit\b/,
      }),
    ).toBeNull();
  });

  it("offers no Edit anywhere to someone who may not update skills", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    render(<SkillDetailPage id="skill-1" />);
    expect(screen.queryByRole("link", { name: /^Edit\b/ })).toBeNull();
  });

  it("says where a synced skill's content comes from and how it keeps up", async () => {
    const user = userEvent.setup();
    mockSkill({
      sourceType: "github",
      sourceRef: "acme/skills@main",
      githubSyncInterval: "1h",
      githubSyncRef: "main",
      lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    render(<SkillDetailPage id="skill-1" />);

    expect(screen.getByText("Synced from GitHub")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Access and source" }));
    expect(screen.getByRole("link", { name: /acme\/skills/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/skills/tree/main",
    );
    expect(
      screen.getByText(/Synced every hour — last synced/),
    ).toBeInTheDocument();
  });

  it("shows a not-found state for a deleted or inaccessible skill", () => {
    vi.mocked(useSkill).mockReturnValue({
      data: null,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    render(<SkillDetailPage id="skill-1" />);

    expect(screen.getByText("Skill not found")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Edit\b/ })).toBeNull();
  });
});
