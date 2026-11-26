import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/skills/skill.query", () => ({ useDeleteSkill: vi.fn() }));

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDeleteSkill } from "@/lib/skills/skill.query";
import { DeleteSkillDialog } from "./delete-skill-dialog";

const mutateAsync = vi.fn();

/** Whether the reader manages every skill, which opens the deleted view. */
function mockCanOpenDeletedView(canOpen: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: canOpen,
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

function renderDialog() {
  return render(
    <DeleteSkillDialog
      skill={{ id: "skill-1", name: "pdf-tools" }}
      open
      onOpenChange={vi.fn()}
    />,
  );
}

describe("DeleteSkillDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useDeleteSkill).mockReturnValue({
      mutateAsync,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
  });

  it("says the skill is kept and can be restored, not that it is gone for good", () => {
    mockCanOpenDeletedView(true);
    renderDialog();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Its instructions, files and versions are kept.",
    );
    expect(dialog).toHaveTextContent(
      "set the status filter of the skills list to Deleted",
    );
    // What the dialog used to promise, and the delete never did.
    expect(dialog).not.toHaveTextContent("cannot be undone");
    expect(dialog).not.toHaveTextContent("removes its instructions");
  });

  it("points a reader without the deleted view to an admin instead of a filter they do not have", () => {
    mockCanOpenDeletedView(false);
    renderDialog();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("An admin can restore it.");
    expect(dialog).not.toHaveTextContent("status filter");
  });

  it("sends one delete for a double click on the confirm button", async () => {
    mockCanOpenDeletedView(true);
    // Still in flight: the button has not re-rendered as busy yet, which is
    // the gap the second click used to get through.
    mutateAsync.mockReturnValue(new Promise(() => undefined));
    renderDialog();

    await userEvent.dblClick(
      screen.getByRole("button", { name: "Delete skill" }),
    );

    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });
});
