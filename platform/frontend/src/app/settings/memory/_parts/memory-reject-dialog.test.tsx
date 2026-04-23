import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRejectDialog } from "./memory-reject-dialog";
import type { MemoryListItem } from "./memory-utils";

const rejectMutateAsync = vi.fn();

const SelectContext = React.createContext<{
  onValueChange?: (value: string) => void;
}>({});

vi.mock("@/lib/memory.query", () => ({
  useRejectMemory: () => ({ mutateAsync: rejectMutateAsync, isPending: false }),
}));

vi.mock("@/components/form-dialog", () => ({
  FormDialog: ({
    children,
    open,
    title,
  }: {
    children: React.ReactNode;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <div>
        <h1>{title}</h1>
        {children}
      </div>
    ) : null,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange?: (value: string) => void;
  }) => (
    <SelectContext.Provider value={{ onValueChange }}>
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

function createItem(id: string): MemoryListItem {
  return {
    id,
    organizationId: "org-1",
    scopeType: "user",
    scopeId: "user-1",
    kind: "preference",
    status: "candidate",
    content: `content ${id}`,
    createdBy: "user-1",
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: "inaccurate",
    rejectionComment: null,
    extractorVersion: null,
    policyFlags: [],
    sourceConversationId: null,
    sourceMessageIds: null,
    supersedesMemoryId: null,
    confidenceBand: "medium",
    language: "en",
    lastVerifiedAt: null,
    expiresAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-01-02T00:00:00.000Z").toISOString(),
  };
}

describe("MemoryRejectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rejectMutateAsync.mockResolvedValue({ id: "memory-1" });
  });

  it("requires rejection reason before enabling submit", () => {
    render(
      <MemoryRejectDialog
        item={createItem("memory-1")}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("submits single reject with trimmed optional comment", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <MemoryRejectDialog
        item={createItem("memory-1")}
        open
        onOpenChange={onOpenChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sensitive" }));
    await user.type(screen.getByLabelText("Comment (optional)"), "  note  ");
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(rejectMutateAsync).toHaveBeenCalledWith({
      id: "memory-1",
      body: {
        rejectionReason: "sensitive",
        rejectionComment: "note",
      },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("applies selected reason to every bulk target", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRejectDialog
        items={[createItem("memory-1"), createItem("memory-2")]}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Reject 2 items")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Duplicate" }));
    await user.click(screen.getByRole("button", { name: "Reject 2" }));

    expect(rejectMutateAsync).toHaveBeenCalledTimes(2);
    expect(rejectMutateAsync).toHaveBeenNthCalledWith(1, {
      id: "memory-1",
      body: {
        rejectionReason: "duplicate",
        rejectionComment: undefined,
      },
    });
    expect(rejectMutateAsync).toHaveBeenNthCalledWith(2, {
      id: "memory-2",
      body: {
        rejectionReason: "duplicate",
        rejectionComment: undefined,
      },
    });
  });
});
