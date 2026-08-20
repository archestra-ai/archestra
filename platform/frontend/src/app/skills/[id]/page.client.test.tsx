import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
// Monaco does not render in jsdom; the canonical mock is a textarea.
vi.mock("@/components/editor");
vi.mock("@/lib/skills/skill.query", () => ({
  useSkill: vi.fn(),
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
import { useSkill } from "@/lib/skills/skill.query";
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
  // Step-rank sections render h2, the sections inside a step h3.
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
    mockSkill();
  });

  it("reads the skill: its facts as the heading section, then its content, nothing editable", () => {
    render(<SkillDetailPage id="skill-1" />);

    expect(
      screen.getByRole("heading", { name: /pdf-tools/ }),
    ).toBeInTheDocument();
    // The facts: who can use it, where, where it comes from, which version.
    expect(screen.getByText("Accessible to")).toBeInTheDocument();
    expect(screen.getByText("All environments")).toBeInTheDocument();
    expect(screen.getByText("Written in Archestra")).toBeInTheDocument();
    expect(screen.getByText("v7")).toBeInTheDocument();
    expect(screen.getByText(/3 times/)).toBeInTheDocument();

    // The content, in the wizard's own editor, read-only — with its files.
    const content = section("Content");
    const editor = content.getByRole("textbox", {
      name: "File contents",
    }) as HTMLTextAreaElement;
    expect(editor.value).toContain("Use pdftotext -layout.");
    expect(editor).toHaveAttribute("readonly");
    expect(content.getByText("notes.md")).toBeInTheDocument();
    // No save anywhere: the page header's Edit is the way to change it.
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/skills/skill-1/edit",
    );
  });

  it("offers no Edit to someone who may not update skills", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    render(<SkillDetailPage id="skill-1" />);
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });

  it("says where a synced skill's content comes from and how it keeps up", () => {
    mockSkill({
      sourceType: "github",
      sourceRef: "acme/skills@main",
      githubSyncInterval: "1h",
      githubSyncRef: "main",
      lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    render(<SkillDetailPage id="skill-1" />);

    expect(screen.getByText("Synced from GitHub")).toBeInTheDocument();
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
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });
});
