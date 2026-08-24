import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationProjectActions } from "./conversation-project-actions";

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/command", () => ({
  Command: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandInput: ({ placeholder }: { placeholder: string }) => (
    <input placeholder={placeholder} />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandEmpty: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
}));

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

    fireEvent.click(screen.getByRole("button", { name: "Research" }));
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

    fireEvent.click(screen.getByRole("button", { name: "PPlanning" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove from project" }),
    );

    expect(onProjectChange).toHaveBeenNthCalledWith(1, "project-2");
    expect(onProjectChange).toHaveBeenNthCalledWith(2, null);
  });
});
