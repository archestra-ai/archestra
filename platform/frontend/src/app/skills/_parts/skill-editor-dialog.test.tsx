import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import { useGithubAppConfigs } from "@/lib/github-app-config.query";
import { useGithubPats } from "@/lib/github-pat.query";
import {
  useCreateSkill,
  useSkill,
  useUpdateSkill,
  useUpdateSkillGithubSync,
} from "@/lib/skills/skill.query";
import { SkillEditorDialog } from "./skill-editor-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/github-app-config.query");
vi.mock("@/lib/github-pat.query");

vi.mock("@/lib/skills/skill.query", () => ({
  useSkill: vi.fn(),
  useCreateSkill: vi.fn(),
  useUpdateSkill: vi.fn(),
  useUpdateSkillGithubSync: vi.fn(),
}));

// Both pull their options over the network; neither has anything to do with
// what a save is anchored to.
vi.mock("./skill-scope-selector", () => ({
  SkillScopeSelector: () => null,
}));

vi.mock("@/components/environment-multi-selector", () => ({
  EnvironmentMultiSelector: () => null,
}));

const updateMutateAsync = vi.fn();
const createMutateAsync = vi.fn();

/** The skill as loaded into the form, sitting at version 7. */
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
      githubSyncInterval: null,
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

function renderEditor(skillId: string | null = "skill-1") {
  return render(
    <SkillEditorDialog skillId={skillId} open onOpenChange={() => {}} />,
  );
}

const save = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Save skill" }));
};

describe("SkillEditorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMutateAsync.mockResolvedValue({ id: "skill-1" });
    createMutateAsync.mockResolvedValue({ id: "skill-1" });
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(useMissingPermissions).mockReturnValue({});
    vi.mocked(useGithubAppConfigs).mockReturnValue({
      data: [],
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(useGithubPats).mockReturnValue({
      data: [],
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(useUpdateSkill).mockReturnValue({
      mutateAsync: updateMutateAsync,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
    vi.mocked(useCreateSkill).mockReturnValue({
      mutateAsync: createMutateAsync,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
    vi.mocked(useUpdateSkillGithubSync).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
    mockSkill();
  });

  it("anchors a save to the version the form was loaded from", async () => {
    renderEditor();
    await save();

    // `files` is a whole-set replacement built from that read, so without the
    // anchor this save would bury anything written since it was loaded.
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "skill-1",
        body: expect.objectContaining({ baseVersion: 7 }),
      }),
    );
  });

  it("does not anchor a synced skill, whose own pulls move the head", async () => {
    mockSkill({ githubSyncInterval: 3600, sourceType: "github" });
    renderEditor();
    await save();

    // The save carries no files and the backend refuses any content change, so
    // there is nothing to bury — anchoring would only let the sync worker
    // reject an unrelated scope edit.
    const body = updateMutateAsync.mock.calls[0][0].body;
    expect(body).not.toHaveProperty("baseVersion");
    expect(body).not.toHaveProperty("files");
  });

  it("does not anchor a create, which has no prior read to be stale about", async () => {
    renderEditor(null);
    await save();

    expect(createMutateAsync).toHaveBeenCalled();
    expect(createMutateAsync.mock.calls[0][0]).not.toHaveProperty(
      "baseVersion",
    );
  });
});
