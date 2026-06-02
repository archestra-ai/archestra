import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NewSkillPage from "./page.client";

interface MockImportSkillsDialogProps {
  open: boolean;
  initialRepoUrl?: string;
  initialSkillPath?: string;
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

vi.mock("../_parts/skill-index", () => ({
  SKILL_INDEX_ENTRY_COUNT: 1,
  searchSkillIndex: (query: string) =>
    query.trim()
      ? [
          {
            repo: "acme/skills",
            repoDescription: "Example skills.",
            repoStars: 42,
            skillPath: "skills/policy-designer",
            name: "Policy Designer",
            description: "Write tool invocation policies.",
            compatibility: null,
            fileCount: 3,
            sourceRef: "acme/skills@main:skills/policy-designer",
          },
        ]
      : [],
}));

vi.mock("../_parts/import-skills-dialog", () => ({
  ImportSkillsDialog: (props: MockImportSkillsDialogProps) =>
    props.open ? (
      <div data-testid="import-skills-dialog">
        {props.initialRepoUrl}:{props.initialSkillPath}
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
