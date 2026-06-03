import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportSkillsDialog } from "./import-skills-dialog";

const mocks = vi.hoisted(() => ({
  discoverGithubSkills: vi.fn(),
  importGithubSkills: vi.fn(),
}));

vi.mock("@/lib/skills/skill.query", () => ({
  useDiscoverGithubSkills: () => ({
    mutateAsync: mocks.discoverGithubSkills,
    isPending: false,
  }),
  useImportGithubSkills: () => ({
    mutateAsync: mocks.importGithubSkills,
    isPending: false,
  }),
  usePreviewGithubSkill: () => ({ data: null, isPending: false }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents/skills/new",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("./skill-editor-dialog", () => ({
  SkillEditorDialog: () => null,
}));

vi.mock("./skill-scope-selector", () => ({
  SkillScopeSelector: () => null,
}));

describe("ImportSkillsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discoverGithubSkills.mockResolvedValue({
      data: {
        repoUrl: "acme/skills",
        ref: "main",
        skills: [
          discoveredSkill({ name: "Target skill", skillPath: "skills/target" }),
          discoveredSkill({ name: "Other skill", skillPath: "skills/other" }),
        ],
      },
      errorMessage: null,
    });
  });

  it("shows the indexed skill on the confirm step without scanning the repo", async () => {
    render(
      <ImportSkillsDialog
        open
        onOpenChange={vi.fn()}
        initialRepoUrl="acme/skills"
        initialSkill={{
          skillPath: "skills/target",
          name: "Target skill",
          description: "Target skill description",
          compatibility: null,
          fileCount: 3,
        }}
        autoDiscover
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Deselect Target skill" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 of 1 selected")).toBeInTheDocument();
    expect(mocks.discoverGithubSkills).not.toHaveBeenCalled();
  });

  it("imports the indexed skill from the confirm step", async () => {
    mocks.importGithubSkills.mockResolvedValue({
      created: ["skills/target"],
      skipped: [],
    });
    const onImported = vi.fn();

    render(
      <ImportSkillsDialog
        open
        onOpenChange={vi.fn()}
        onImported={onImported}
        initialRepoUrl="acme/skills"
        initialSkill={{
          skillPath: "skills/target",
          name: "Target skill",
          description: "Target skill description",
          compatibility: null,
          fileCount: 3,
        }}
        autoDiscover
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /^Import/ }),
    );

    await waitFor(() => {
      expect(mocks.importGithubSkills).toHaveBeenCalledWith(
        expect.objectContaining({
          repoUrl: "acme/skills",
          skillPaths: ["skills/target"],
        }),
      );
    });
    expect(onImported).toHaveBeenCalled();
  });

  it("keeps the dialog open when the import created nothing", async () => {
    mocks.importGithubSkills.mockResolvedValue({
      created: [],
      skipped: ["skills/target"],
    });
    const onImported = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <ImportSkillsDialog
        open
        onOpenChange={onOpenChange}
        onImported={onImported}
        initialRepoUrl="acme/skills"
        initialSkill={{
          skillPath: "skills/target",
          name: "Target skill",
          description: "Target skill description",
          compatibility: null,
          fileCount: 3,
        }}
        autoDiscover
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /^Import/ }),
    );

    await waitFor(() => {
      expect(mocks.importGithubSkills).toHaveBeenCalled();
    });
    expect(onImported).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("can show a repo-root indexed skill", async () => {
    render(
      <ImportSkillsDialog
        open
        onOpenChange={vi.fn()}
        initialRepoUrl="acme/skills"
        initialSkill={{
          skillPath: "",
          name: "Root skill",
          description: "Root skill description",
          compatibility: null,
          fileCount: 0,
        }}
        autoDiscover
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Deselect Root skill" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 of 1 selected")).toBeInTheDocument();
    expect(mocks.discoverGithubSkills).not.toHaveBeenCalled();
  });

  it("scans the repo when no indexed skill is provided", async () => {
    render(
      <ImportSkillsDialog
        open
        onOpenChange={vi.fn()}
        initialRepoUrl="acme/skills"
        autoDiscover
      />,
    );

    await waitFor(() => {
      expect(mocks.discoverGithubSkills).toHaveBeenCalledWith({
        repoUrl: "acme/skills",
      });
    });

    expect(
      await screen.findByRole("button", { name: "Deselect Target skill" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Deselect Other skill" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
  });
});

function discoveredSkill(overrides: {
  name: string;
  skillPath: string;
  exists?: boolean;
}) {
  return {
    name: overrides.name,
    description: `${overrides.name} description`,
    compatibility: null,
    skillPath: overrides.skillPath,
    fileCount: 0,
    exists: overrides.exists ?? false,
  };
}
