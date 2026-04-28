import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDetailDrawer } from "./memory-detail-drawer";
import type { MemoryListItem } from "./memory-utils";

let currentMemory: MemoryListItem | null = null;
let currentUserId = "user-1";
let currentRole: "admin" | "member" | "team_admin" = "admin";
let canApprovePermission = true;
let canUpdatePermission = true;
let canDeletePermission = true;

const approveMutateAsync = vi.fn();
const archiveMutateAsync = vi.fn();
const unarchiveMutateAsync = vi.fn();
const deleteMutateAsync = vi.fn();

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/lib/memory.query", () => ({
  useMemory: () => ({ data: currentMemory, isPending: false }),
  useApproveMemory: () => ({
    mutateAsync: approveMutateAsync,
    isPending: false,
  }),
  useArchiveMemory: () => ({
    mutateAsync: archiveMutateAsync,
    isPending: false,
  }),
  useUnarchiveMemory: () => ({
    mutateAsync: unarchiveMutateAsync,
    isPending: false,
  }),
  useDeleteMemory: () => ({ mutateAsync: deleteMutateAsync, isPending: false }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: currentUserId, name: "Admin" } } }),
  useHasPermissions: ({ memory }: { memory: string[] }) => {
    const action = memory[0];
    if (action === "approve") return { data: canApprovePermission };
    if (action === "update") return { data: canUpdatePermission };
    if (action === "delete") return { data: canDeletePermission };
    return { data: false };
  },
}));

vi.mock("@/lib/organization.query", () => ({
  useActiveOrganization: () => ({ data: { id: "org-1" } }),
  useActiveMemberRole: () => ({ data: currentRole }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: () => ({ data: [{ id: "team-1", name: "Team 1" }] }),
}));

vi.mock("@/lib/utils/date-time", () => ({
  formatDate: () => "2026-01-01",
  formatRelativeTimeFromNow: () => "1 day ago",
}));

function createMemory(status: MemoryListItem["status"]): MemoryListItem {
  return {
    id: "memory-1",
    organizationId: "org-1",
    scopeType: "user",
    scopeId: "user-1",
    kind: "preference",
    status,
    content: `content ${status}`,
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
  } as MemoryListItem;
}

describe("MemoryDetailDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMemory = createMemory("candidate");
    currentUserId = "user-1";
    currentRole = "admin";
    canApprovePermission = true;
    canUpdatePermission = true;
    canDeletePermission = true;
  });

  it("renders approved action set: Archive, Re-propose, Reject", () => {
    currentMemory = createMemory("approved");

    render(
      <MemoryDetailDrawer
        memoryId="memory-1"
        open
        onOpenChange={vi.fn()}
        onReject={vi.fn()}
        onRepropose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Archive" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Re-propose" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reject" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });

  it("renders archived action set: Restore, Re-propose, Delete", () => {
    currentMemory = createMemory("archived");

    render(
      <MemoryDetailDrawer
        memoryId="memory-1"
        open
        onOpenChange={vi.fn()}
        onReject={vi.fn()}
        onRepropose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Restore" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Re-propose" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
  });

  it("calls callbacks for approve flow actions", async () => {
    currentMemory = createMemory("approved");
    const onReject = vi.fn();
    const onRepropose = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryDetailDrawer
        memoryId="memory-1"
        open
        onOpenChange={vi.fn()}
        onReject={onReject}
        onRepropose={onRepropose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Re-propose" }));
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(onRepropose).toHaveBeenCalledWith(currentMemory);
    expect(onReject).toHaveBeenCalledWith(currentMemory);
  });

  it("disables actions when user is out of scope", () => {
    currentMemory = {
      ...createMemory("candidate"),
      scopeType: "user",
      scopeId: "another-user",
    };
    currentUserId = "user-1";
    currentRole = "member";

    render(
      <MemoryDetailDrawer
        memoryId="memory-1"
        open
        onOpenChange={vi.fn()}
        onReject={vi.fn()}
        onRepropose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();
  });
});
