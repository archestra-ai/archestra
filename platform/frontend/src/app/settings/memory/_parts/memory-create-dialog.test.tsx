import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCreateDialog } from "./memory-create-dialog";

const createMutateAsync = vi.fn();

const SelectContext = React.createContext<{
  onValueChange?: (value: string) => void;
  value?: string;
}>({});

vi.mock("@/lib/memory.query", () => ({
  useCreateMemory: () => ({
    mutateAsync: createMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/components/form-dialog", () => ({
  FormDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div>{children}</div> : null),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <SelectContext.Provider value={{ value, onValueChange }}>
      <div>{children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({
    children,
    id,
  }: {
    children: React.ReactNode;
    id?: string;
  }) => <div data-testid={id}>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => {
    const context = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => context.onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

describe("MemoryCreateDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMutateAsync.mockResolvedValue({ id: "created" });
  });

  it("autofills scopeId from selected scope type", async () => {
    const user = userEvent.setup();

    render(
      <MemoryCreateDialog
        open
        onOpenChange={vi.fn()}
        currentUserId="user-1"
        organizationId="org-1"
        teams={[
          { id: "team-1", name: "Team 1" },
          { id: "team-2", name: "Team 2" },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Team" }));
    await user.type(screen.getByLabelText("Content"), "team scope memory");
    await user.click(screen.getByRole("button", { name: "Propose memory" }));

    expect(createMutateAsync).toHaveBeenCalledWith({
      scopeType: "team",
      scopeId: "team-1",
      kind: "preference",
      content: "team scope memory",
    });
  });

  it("submits trimmed content", async () => {
    const user = userEvent.setup();

    render(
      <MemoryCreateDialog
        open
        onOpenChange={vi.fn()}
        currentUserId="user-1"
        organizationId="org-1"
        teams={[]}
      />,
    );

    await user.type(screen.getByLabelText("Content"), "  trimmed text  ");
    await user.click(screen.getByRole("button", { name: "Propose memory" }));

    expect(createMutateAsync).toHaveBeenCalledWith({
      scopeType: "user",
      scopeId: "user-1",
      kind: "preference",
      content: "trimmed text",
    });
  });

  it("keeps submit disabled when no scope target is available", async () => {
    const user = userEvent.setup();

    render(
      <MemoryCreateDialog
        open
        onOpenChange={vi.fn()}
        currentUserId={null}
        organizationId={null}
        teams={[]}
      />,
    );

    await user.type(screen.getByLabelText("Content"), "content");

    expect(
      screen.getByRole("button", { name: "Propose memory" }),
    ).toBeDisabled();
  });
});
