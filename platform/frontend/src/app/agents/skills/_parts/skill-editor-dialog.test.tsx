import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillEditorDialog } from "./skill-editor-dialog";

const { updateSkillMutateAsyncMock, useSkillMock } = vi.hoisted(() => ({
  updateSkillMutateAsyncMock: vi.fn(),
  useSkillMock: vi.fn(),
}));

vi.mock("@/components/standard-dialog", () => ({
  StandardDialog: ({
    children,
    footer,
  }: {
    children: ReactNode;
    footer?: ReactNode;
  }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));

vi.mock("@/lib/skills/skill.query", () => ({
  useCreateSkill: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useSkill: useSkillMock,
  useUpdateSkill: () => ({
    mutateAsync: updateSkillMutateAsyncMock,
    isPending: false,
  }),
}));

vi.mock("./skill-scope-selector", () => ({
  SkillScopeSelector: () => <div>Scope selector</div>,
}));

describe("SkillEditorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSkillMutateAsyncMock.mockResolvedValue({ id: "skill-1" });
  });

  it("quotes regenerated frontmatter values when saving imported skills", async () => {
    useSkillMock.mockReturnValue({
      data: {
        id: "skill-1",
        name: "warehouse-postgres",
        description: "Warehouse Postgres: projects, scaling, connectivity",
        content: "# Warehouse Postgres\n\nUse the CLI.",
        license: "Apache-2.0: custom",
        compatibility: "Requires warehouse CLI (>= v0.294.0)",
        metadata: {
          "owner:team": "data: platform",
        },
        files: [],
        scope: "personal",
        teams: [],
      },
      isPending: false,
    });

    render(<SkillEditorDialog skillId="skill-1" open onOpenChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Save skill" }));

    await waitFor(() => expect(updateSkillMutateAsyncMock).toHaveBeenCalled());
    const payload = updateSkillMutateAsyncMock.mock.calls[0][0];
    expect(payload.body.content).toContain(
      'description: "Warehouse Postgres: projects, scaling, connectivity"',
    );
    expect(payload.body.content).toContain('license: "Apache-2.0: custom"');
    expect(payload.body.content).toContain(
      'compatibility: "Requires warehouse CLI (>= v0.294.0)"',
    );
    expect(payload.body.content).toContain('  "owner:team": "data: platform"');
  });
});
