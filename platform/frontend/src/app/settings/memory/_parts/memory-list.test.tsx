import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryList } from "./memory-list";
import type { MemoryListItem } from "./memory-utils";

const setSettingsActionMock = vi.fn();
const updateQueryParamsMock = vi.fn();
const setPaginationMock = vi.fn();

const mutateAsyncMock = vi.fn();

let currentStatus: "candidate" | "approved" | "archived" | "rejected" =
  "candidate";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-1", name: "Admin" } } }),
  useHasPermissions: ({ memory }: { memory: string[] }) => {
    const action = memory[0];
    return { data: ["approve", "update", "delete"].includes(action) };
  },
}));

vi.mock("@/lib/organization.query", () => ({
  useActiveOrganization: () => ({ data: { id: "org-1" } }),
  useActiveMemberRole: () => ({ data: "admin" }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: () => ({ data: [{ id: "team-1", name: "Team 1" }] }),
}));

vi.mock("@/lib/hooks/use-data-table-query-params", () => ({
  useDataTableQueryParams: () => ({
    searchParams: new URLSearchParams({ status: currentStatus }),
    pageIndex: 0,
    pageSize: 50,
    offset: 0,
    setPagination: setPaginationMock,
    updateQueryParams: updateQueryParamsMock,
  }),
}));

vi.mock("../../layout", () => ({
  useSetSettingsAction: () => setSettingsActionMock,
}));

vi.mock("@/components/search-input", () => ({
  SearchInput: () => <input aria-label="Search memory items" />,
}));

vi.mock("@/lib/memory.query", () => ({
  useMemoryPaginated: ({ status }: { status?: MemoryListItem["status"] }) => ({
    data: {
      data: [createMemoryItem(status ?? "candidate")],
      pagination: {
        currentPage: 1,
        limit: 50,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    isPending: false,
    isFetching: false,
  }),
  useMemoryInjectionEnabled: () => true,
  useMemoryExtractionAvailable: () => true,
  useApproveMemory: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
  useArchiveMemory: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
  useCreateMemory: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
  useDeleteMemory: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
  useRejectMemory: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
  useUnarchiveMemory: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: false,
  }),
}));

vi.mock("./memory-create-dialog", () => ({
  MemoryCreateDialog: () => null,
}));

vi.mock("./memory-reject-dialog", () => ({
  MemoryRejectDialog: () => null,
}));

vi.mock("./memory-detail-drawer", () => ({
  MemoryDetailDrawer: () => null,
}));

function createMemoryItem(status: MemoryListItem["status"]): MemoryListItem {
  return {
    id: "memory-1",
    organizationId: "org-1",
    scopeType: "user",
    scopeId: "user-1",
    kind: "preference",
    status,
    content: `memory for ${status}`,
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

describe("MemoryList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentStatus = "candidate";
  });

  it("shows archive-first actions for non-archived statuses", async () => {
    const user = userEvent.setup();

    render(<MemoryList />);

    await user.click(
      screen.getByRole("button", { name: "Open memory actions" }),
    );

    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });

  it("shows Re-propose and Reject actions for approved items", async () => {
    currentStatus = "approved";
    const user = userEvent.setup();

    render(<MemoryList />);

    await user.click(
      screen.getByRole("button", { name: "Open memory actions" }),
    );

    expect(screen.getByRole("menuitem", { name: "Re-propose" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Reject" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });

  it("shows Restore, Re-propose and Delete for archived items", async () => {
    currentStatus = "archived";
    const user = userEvent.setup();

    render(<MemoryList />);

    await user.click(
      screen.getByRole("button", { name: "Open memory actions" }),
    );

    expect(screen.getByRole("menuitem", { name: "Restore" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Re-propose" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  });

  it("does not render bulk Clear action", async () => {
    const user = userEvent.setup();

    render(<MemoryList />);

    await user.click(screen.getByRole("checkbox", { name: "Select row" }));

    expect(screen.getByText("1 selected")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Clear" }),
    ).not.toBeInTheDocument();
  });
});
