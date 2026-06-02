import { render, screen, waitFor } from "@testing-library/react";
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

  it("preselects only the requested skill after auto-discovery", async () => {
    render(
      <ImportSkillsDialog
        open
        onOpenChange={vi.fn()}
        initialRepoUrl="acme/skills"
        initialSkillPath="skills/target"
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
      screen.getByRole("button", { name: "Select Other skill" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();
  });

  it("does not select the whole repo when the requested skill already exists", async () => {
    mocks.discoverGithubSkills.mockResolvedValue({
      data: {
        repoUrl: "acme/skills",
        ref: "main",
        skills: [
          discoveredSkill({
            name: "Target skill",
            skillPath: "skills/target",
            exists: true,
          }),
          discoveredSkill({ name: "Other skill", skillPath: "skills/other" }),
        ],
      },
      errorMessage: null,
    });

    render(
      <ImportSkillsDialog
        open
        onOpenChange={vi.fn()}
        initialRepoUrl="acme/skills"
        initialSkillPath="skills/target"
        autoDiscover
      />,
    );

    expect(
      await screen.findByRole("button", {
        name: "Target skill (already imported)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Select Other skill" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("0 of 1 selected · 1 imported"),
    ).toBeInTheDocument();
  });

  it("can preselect a repo-root skill", async () => {
    mocks.discoverGithubSkills.mockResolvedValue({
      data: {
        repoUrl: "acme/skills",
        ref: "main",
        skills: [
          discoveredSkill({ name: "Root skill", skillPath: "" }),
          discoveredSkill({ name: "Other skill", skillPath: "skills/other" }),
        ],
      },
      errorMessage: null,
    });

    render(
      <ImportSkillsDialog
        open
        onOpenChange={vi.fn()}
        initialRepoUrl="acme/skills"
        initialSkillPath=""
        autoDiscover
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Deselect Root skill" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Select Other skill" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();
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
