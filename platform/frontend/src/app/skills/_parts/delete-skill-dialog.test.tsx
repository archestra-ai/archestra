import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/skills/skill.query", () => ({ useDeleteSkill: vi.fn() }));

import { usePathname } from "next/navigation";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDeleteSkill } from "@/lib/skills/skill.query";
import {
  DeleteSkillDialog,
  SkillDeleteDescription,
} from "./delete-skill-dialog";

const mutateAsync = vi.fn();

/** Whether the reader manages every skill, which opens the deleted view. */
function mockCanOpenDeletedView(canOpen: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: canOpen,
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

const onOpenChange = vi.fn();

function renderDialog() {
  return render(
    <DeleteSkillDialog
      skill={{ id: "skill-1", name: "pdf-tools" }}
      open
      onOpenChange={onOpenChange}
    />,
  );
}

/** The page the dialog is opened on. */
function mockLocation(pathname: string) {
  vi.mocked(usePathname).mockReturnValue(pathname);
}

describe("DeleteSkillDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocation("/skills");
    vi.mocked(useDeleteSkill).mockReturnValue({
      mutateAsync,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
  });

  it("says what is lost and where deleted skills are restored, in two short rows", () => {
    mockCanOpenDeletedView(true);
    renderDialog();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Agents will no longer be able to use pdf-tools skill.",
    );
    // Named as a link to the skill's own page, to look before deciding.
    expect(screen.getByRole("link", { name: "pdf-tools" })).toHaveAttribute(
      "href",
      "/skills/skill-1",
    );
    expect(dialog).toHaveTextContent(
      "You can restore deleted skills from the Deleted filter on this page.",
    );
    // The title asks; the text does not ask again or name the skill.
    expect(dialog).not.toHaveTextContent('Delete "pdf-tools"?');
    // What the dialog used to promise, and the delete never did.
    expect(dialog).not.toHaveTextContent("cannot be undone");
  });

  it("links Deleted to the plain deleted view, leaving the list's filters behind", async () => {
    mockCanOpenDeletedView(true);
    renderDialog();

    const link = screen.getByRole("link", { name: "Deleted" });
    // The skill just deleted may not match the search it was found with.
    expect(link).toHaveAttribute("href", "/skills?page=1&status=deleted");
    // Following it leaves the question behind.
    await userEvent.click(link);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("links to the Skills list from a skill's own page, and says so", () => {
    mockCanOpenDeletedView(true);
    mockLocation("/skills/skill-1");
    renderDialog();

    expect(screen.getByRole("link", { name: "Deleted" })).toHaveAttribute(
      "href",
      "/skills?page=1&status=deleted",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "You can restore deleted skills from the Deleted filter on the Skills page.",
    );
  });

  it("points a reader without the deleted view to an admin instead of a filter they do not have", () => {
    mockCanOpenDeletedView(false);
    renderDialog();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("An admin can restore deleted skills.");
    expect(screen.queryByRole("link", { name: "Deleted" })).toBeNull();
  });

  it("names several skills as skills, for the bulk delete", () => {
    mockCanOpenDeletedView(true);
    const { container } = render(
      <SkillDeleteDescription
        skills={[
          { id: "skill-1", name: "pdf-tools" },
          { id: "skill-2", name: "csv-tools" },
        ]}
        canOpenDeletedView
      />,
    );

    expect(container).toHaveTextContent(
      "Agents will no longer be able to use pdf-tools and csv-tools skills.",
    );
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
