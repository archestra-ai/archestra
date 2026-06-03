import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NewSkillPage from "./page.client";

interface MockImportSkillsDialogProps {
  open: boolean;
  initialRepoUrl?: string;
  initialSkill?: { skillPath: string };
}

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents/skills/new",
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    children,
    actionButton,
  }: {
    children: React.ReactNode;
    actionButton: React.ReactNode;
  }) => (
    <main>
      {actionButton}
      {children}
    </main>
  ),
}));

// lazily loaded by the page on first search; the real search logic in
// ../_parts/skill-index runs against these entries.
vi.mock("../_parts/skill-index-data", () => ({
  SKILL_INDEX_ENTRY_COUNT: 1,
  SKILL_INDEX_ENTRIES: [
    {
      repo: "acme/skills",
      repoDescription: "Example skills.",
      skillPath: "skills/policy-designer",
      name: "Policy Designer",
      description: "Write tool invocation policies.",
      compatibility: null,
      fileCount: 3,
    },
  ],
}));

vi.mock("../_parts/import-skills-dialog", () => ({
  ImportSkillsDialog: (props: MockImportSkillsDialogProps) =>
    props.open ? (
      <div data-testid="import-skills-dialog">
        {props.initialRepoUrl}:{props.initialSkill?.skillPath}
      </div>
    ) : null,
}));

vi.mock("../_parts/skill-editor-dialog", () => ({
  SkillEditorDialog: () => null,
}));

describe("NewSkillPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the import dialog for a selected indexed skill", async () => {
    const user = userEvent.setup();
    render(<NewSkillPage />);

    await user.type(
      screen.getByPlaceholderText(
        "Search skills by name, repo, or use case...",
      ),
      "policy",
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Import Policy Designer from acme/skills",
      }),
    );

    expect(screen.getByTestId("import-skills-dialog")).toHaveTextContent(
      "acme/skills:skills/policy-designer",
    );
  });
});
