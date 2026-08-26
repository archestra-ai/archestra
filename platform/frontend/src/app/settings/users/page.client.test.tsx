import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/member.query", () => ({
  useAllMatchingMembers: vi.fn(() => ({ data: [], isFetching: false })),
  useMembersPaginated: vi.fn(),
  useInvitationsPaginated: vi.fn(() => ({
    data: { data: [], pagination: { total: 0 } },
    isPending: false,
    isFetching: false,
  })),
  useCancelInvitationMutation: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useRemoveMember: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useUpdateMemberRole: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: CURRENT_USER_ID } } }),
  useHasPermissions: () => ({ data: true }),
}));
vi.mock("@/lib/impersonation.query", () => ({
  useCanImpersonate: () => false,
  useImpersonationCandidates: () => ({ data: [] }),
  useImpersonateUser: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/role.query", () => ({ useRoles: () => ({ data: [] }) }));
vi.mock("@/components/small-team-tier-banner", () => ({
  SmallTeamTierBanner: () => null,
}));
vi.mock("@/components/search-input", () => ({
  SearchInput: () => <input aria-label="Search users by name and email" />,
}));
vi.mock("../layout", () => ({ useSetSettingsAction: () => vi.fn() }));

import { useSearchParams } from "next/navigation";
import { useDisableInvitations } from "@/lib/config/config.query";
import { type Member, useMembersPaginated } from "@/lib/member.query";
import {
  useActiveOrganization,
  useDeletePendingSignupMember,
  useMemberSignupStatus,
  useOrganization,
} from "@/lib/organization.query";
import UsersPageClient from "./page.client";

const CURRENT_USER_ID = "user-current";
const PAGE_SIZE = 10;

function makeMember(index: number): Member {
  const id = String(index).padStart(2, "0");
  return {
    id: `member-${id}`,
    userId: `user-${id}`,
    name: `Member ${id}`,
    email: `member-${id}@example.test`,
    image: null,
    role: "member",
    createdAt: "2026-01-01T00:00:00.000Z",
    twoFactorEnabled: false,
  } as Member;
}

/**
 * A member who was auto-provisioned and never completed signup. These are rows
 * of the same `member` table the list endpoint paginates, so the signup-status
 * response always describes members the list can also return.
 */
function pendingSignupFor(member: Member) {
  return {
    userId: member.userId,
    name: member.name,
    email: member.email,
    image: null,
    role: member.role,
    provider: "microsoft",
    invitationId: "invitation-1",
  };
}

function renderPage({
  members,
  total,
  pendingSignupMembers = [],
  disableInvitations = false,
  searchParams = "",
}: {
  members: Member[];
  total: number;
  pendingSignupMembers?: ReturnType<typeof pendingSignupFor>[];
  disableInvitations?: boolean;
  searchParams?: string;
}) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(searchParams) as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useDisableInvitations).mockReturnValue(disableInvitations);
  vi.mocked(useMembersPaginated).mockReturnValue({
    data: {
      data: members,
      pagination: { total },
    },
    isPending: false,
    isFetching: false,
  } as unknown as ReturnType<typeof useMembersPaginated>);
  vi.mocked(useMemberSignupStatus).mockReturnValue({
    data: { pendingSignupMembers },
  } as unknown as ReturnType<typeof useMemberSignupStatus>);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <UsersPageClient />
    </QueryClientProvider>,
  );
}

function bodyRows() {
  const table = screen.getByRole("table");
  const [, body] = within(table).getAllByRole("rowgroup");
  return within(body).getAllByRole("row");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useActiveOrganization).mockReturnValue({
    data: { id: "org-1" },
    isPending: false,
  } as unknown as ReturnType<typeof useActiveOrganization>);
  vi.mocked(useOrganization).mockReturnValue({
    data: { requireTwoFactor: false },
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useDeletePendingSignupMember).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof useDeletePendingSignupMember>);
});

describe("Users settings — members table", () => {
  it("counts a pending-signup member once, so a full page is not followed by an empty one", () => {
    const members = Array.from({ length: PAGE_SIZE }, (_, i) =>
      makeMember(i + 1),
    );

    renderPage({
      members,
      total: PAGE_SIZE,
      // Two of the members on this page have not signed up yet. Counting them
      // as extra rows advertised a second page whose offset lands past the
      // last member, which rendered as "No results".
      pendingSignupMembers: [
        pendingSignupFor(members[0]),
        pendingSignupFor(members[4]),
      ],
    });

    expect(bodyRows()).toHaveLength(PAGE_SIZE);
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
    expect(screen.getAllByText(members[0].email)).toHaveLength(1);
    expect(screen.getAllByText("Pending (auto-provisioned)")).toHaveLength(2);
  });

  it("marks a pending-signup member on whatever page they sort onto", () => {
    // Page two of a two-page roster: the pending member is only in this page's
    // slice, and must be recognised here rather than stranded on page one.
    const members = Array.from({ length: 4 }, (_, i) => makeMember(i + 11));

    renderPage({
      members,
      total: PAGE_SIZE + members.length,
      pendingSignupMembers: [pendingSignupFor(members[2])],
      searchParams: "page=2",
    });

    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    const row = screen.getByText(members[2].email).closest("tr");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByText("Pending (auto-provisioned)"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Pending (auto-provisioned)")).toHaveLength(1);
  });
});

describe("Users settings — invitations tab", () => {
  const members = [makeMember(1)];

  it("offers the invitations tab when the deployment allows invitations", () => {
    renderPage({ members, total: 1 });

    expect(
      screen.getByRole("tab", { name: "Invitations" }),
    ).toBeInTheDocument();
  });

  it("hides the tab switcher entirely when invitations are disabled", () => {
    renderPage({ members, total: 1, disableInvitations: true });

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("falls back to the users tab for a ?tab=invitations link when invitations are disabled", () => {
    renderPage({
      members,
      total: 1,
      disableInvitations: true,
      searchParams: "tab=invitations",
    });

    expect(screen.getByText(members[0].email)).toBeInTheDocument();
    expect(screen.queryByText("No invitations")).not.toBeInTheDocument();
  });
});
