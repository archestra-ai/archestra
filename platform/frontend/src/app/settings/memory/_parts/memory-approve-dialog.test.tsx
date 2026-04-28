import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryApproveDialog } from "./memory-approve-dialog";
import type { MemoryListItem } from "./memory-utils";

const approveMutateAsync = vi.fn();
const updateMutateAsync = vi.fn();

const SelectContext = React.createContext<{
  onValueChange?: (value: string) => void;
}>({});

vi.mock("@/lib/memory.query", () => ({
  useApproveMemory: () => ({
    mutateAsync: approveMutateAsync,
    isPending: false,
  }),
  useUpdateMemoryCandidate: () => ({
    mutateAsync: updateMutateAsync,
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
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange?: (value: string) => void;
  }) => (
    <SelectContext.Provider value={{ onValueChange }}>
      <div>{children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
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

function createItem(overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return {
    id: "memory-1",
    organizationId: "org-1",
    scopeType: "user",
    scopeId: "user-1",
    kind: "preference",
    status: "candidate",
    content: "original content",
    createdBy: "user-1",
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: "inaccurate",
    rejectionComment: null,
    extractorVersion: null,
    policyFlags: [],
    sourceType: "manual",
    sourceId: null,
    sourceMetadata: null,
    sourceConversationId: null,
    sourceMessageIds: null,
    supersedesMemoryId: null,
    confidenceBand: "medium",
    language: "en",
    scores: null,
    classifications: null,
    scorerVersion: null,
    lastRetrievedAt: null,
    retrievalCount: 0,
    lastVerifiedAt: null,
    expiresAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-01-02T00:00:00.000Z").toISOString(),
    ...overrides,
  } as MemoryListItem;
}

describe("MemoryApproveDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approveMutateAsync.mockResolvedValue({ id: "memory-1" });
    updateMutateAsync.mockResolvedValue({ id: "memory-1" });
  });

  it("updates changed content before approving", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <MemoryApproveDialog
        item={createItem()}
        open
        onOpenChange={onOpenChange}
        disabled={false}
      />,
    );

    await user.clear(screen.getByLabelText("Content"));
    await user.type(screen.getByLabelText("Content"), "updated content");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(updateMutateAsync).toHaveBeenCalledWith({
      id: "memory-1",
      body: { content: "updated content" },
    });
    expect(approveMutateAsync).toHaveBeenCalledWith("memory-1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("skips update when payload has no changes", async () => {
    const user = userEvent.setup();

    render(
      <MemoryApproveDialog
        item={createItem()}
        open
        onOpenChange={vi.fn()}
        disabled={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(updateMutateAsync).not.toHaveBeenCalled();
    expect(approveMutateAsync).toHaveBeenCalledWith("memory-1");
  });

  it("sends partial update payload when kind changes", async () => {
    const user = userEvent.setup();

    render(
      <MemoryApproveDialog
        item={createItem()}
        open
        onOpenChange={vi.fn()}
        disabled={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Instruction" }));
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(updateMutateAsync).toHaveBeenCalledWith({
      id: "memory-1",
      body: { kind: "instruction" },
    });
    expect(approveMutateAsync).toHaveBeenCalledWith("memory-1");
  });
});
