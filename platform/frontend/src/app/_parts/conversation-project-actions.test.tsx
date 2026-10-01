import { PROJECT_NAME_MAX_LENGTH } from "@archestra/shared";
import {
  fireEvent,
  render as renderComponent,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { ConversationProjectActions } from "./conversation-project-actions";

function render(children: ReactNode) {
  const wrap = (content: ReactNode) => (
    <DropdownMenu open modal={false}>
      <DropdownMenuContent>{content}</DropdownMenuContent>
    </DropdownMenu>
  );
  const result = renderComponent(wrap(children));
  fireEvent.keyDown(screen.getByText("Change project"), { key: "ArrowRight" });
  return {
    ...result,
    rerender: (content: ReactNode) => result.rerender(wrap(content)),
  };
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

const projects = [
  { id: "project-1", name: "Research", icon: null },
  { id: "project-2", name: "Planning", icon: "P" },
];

describe("ConversationProjectActions", () => {
  it("moves a chat without a project into a selected project", () => {
    const onProjectChange = vi.fn();
    render(
      <ConversationProjectActions
        projectId={null}
        projects={projects}
        isPending={false}
        onProjectChange={onProjectChange}
      />,
    );

    expect(screen.getByText("Change project")).toBeInTheDocument();
    expect(screen.queryByText("Remove from project")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "Research" }));
    expect(onProjectChange).toHaveBeenCalledWith("project-1");
  });

  it("changes or removes a chat that already belongs to a project", () => {
    const onProjectChange = vi.fn();
    render(
      <ConversationProjectActions
        projectId="project-1"
        projects={projects}
        isPending={false}
        onProjectChange={onProjectChange}
      />,
    );

    fireEvent.click(screen.getByRole("option", { name: /Planning/ }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove from project" }),
    );

    expect(onProjectChange).toHaveBeenNthCalledWith(1, "project-2");
    expect(onProjectChange).toHaveBeenNthCalledWith(2, null);
  });
});

describe("inline project creation", () => {
  it("creates a project by typing a trimmed name and pressing Enter in an empty picker", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onProjectChange = vi.fn();
    render(
      <ConversationProjectActions
        projectId={null}
        projects={[]}
        isPending={false}
        onProjectChange={onProjectChange}
        onCreateProject={onCreateProject}
      />,
    );
    expect(screen.getByText("Type a name to create a project.")).toBeVisible();
    await user.type(screen.getByRole("combobox"), "  New research  ");
    expect(
      screen.getByRole("option", { name: 'Create project "New research"' }),
    ).toBeVisible();
    await user.keyboard("{Enter}");
    expect(onCreateProject).toHaveBeenCalledExactlyOnceWith("New research");
    expect(onProjectChange).not.toHaveBeenCalled();
  });

  it("selects an existing project rather than creating a case-insensitive duplicate", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onProjectChange = vi.fn();
    render(
      <ConversationProjectActions
        projectId={null}
        projects={projects}
        isPending={false}
        onProjectChange={onProjectChange}
        onCreateProject={onCreateProject}
      />,
    );
    await user.type(screen.getByRole("combobox"), "research");
    expect(
      screen.queryByRole("option", { name: /Create project/ }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onProjectChange).toHaveBeenCalledWith("project-1");
    expect(onCreateProject).not.toHaveBeenCalled();
  });

  it("offers creation when searching existing projects has no matches", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    render(
      <ConversationProjectActions
        projectId="project-1"
        projects={projects}
        isPending={false}
        onProjectChange={vi.fn()}
        onCreateProject={onCreateProject}
      />,
    );
    await user.type(screen.getByRole("combobox"), "Invoices");
    expect(
      screen.getByRole("option", { name: 'Create project "Invoices"' }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Research" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onCreateProject).toHaveBeenCalledExactlyOnceWith("Invoices");
  });

  it.each([
    "   ",
    "x".repeat(PROJECT_NAME_MAX_LENGTH + 1),
  ])("rejects invalid project names", async (name) => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    render(
      <ConversationProjectActions
        projectId={null}
        projects={[]}
        isPending={false}
        onProjectChange={vi.fn()}
        onCreateProject={onCreateProject}
      />,
    );
    await user.type(screen.getByRole("combobox"), name);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(onCreateProject).not.toHaveBeenCalled();
  });

  it("does not offer creation without permission", async () => {
    const user = userEvent.setup();
    render(
      <ConversationProjectActions
        projectId={null}
        projects={[]}
        isPending={false}
        onProjectChange={vi.fn()}
      />,
    );
    await user.type(screen.getByRole("combobox"), "Invoices");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("blocks creation while a mutation is pending", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const props = {
      projectId: null,
      projects: [],
      isPending: false,
      onProjectChange: vi.fn(),
      onCreateProject,
    };
    const { rerender } = render(<ConversationProjectActions {...props} />);
    await user.type(screen.getByRole("combobox"), "Invoices");
    rerender(<ConversationProjectActions {...props} isPending />);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(onCreateProject).not.toHaveBeenCalled();
  });
});
