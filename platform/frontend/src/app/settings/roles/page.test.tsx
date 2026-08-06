"use client";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useEnterpriseFeature,
  useSmallTeamTier,
} from "@/lib/config/config.query";

const mockUserSearchableSelect = vi.fn(
  (_props: {
    users: Array<{
      userId: string;
      name?: string | null;
      email?: string | null;
    }>;
    placeholder?: string;
    searchPlaceholder?: string;
  }) => <div data-testid="user-searchable-select" />,
);

const mockImpersonationCandidates = vi.fn(
  () =>
    ({
      data: [],
      isLoading: false,
      isLoadingError: false,
      refetch: vi.fn(),
    }) as {
      data: Array<{
        id: string;
        name: string;
        email: string;
        role: string | null;
      }>;
      isLoading: boolean;
      isLoadingError: boolean;
      refetch: () => void;
    },
);

vi.mock("@/lib/config/config.query");

vi.mock("@/components/roles/roles-list.ee", () => ({
  // The real list renders headerAction opposite its search field; the stub has
  // to render it too or the debugger trigger disappears from the page.
  RolesList: ({ headerAction }: { headerAction?: React.ReactNode }) => (
    <div>
      roles list
      {headerAction}
    </div>
  ),
}));

vi.mock("@/components/user-searchable-select", () => ({
  UserSearchableSelect: (
    props: Parameters<typeof mockUserSearchableSelect>[0],
  ) => mockUserSearchableSelect(props),
}));

vi.mock("@/lib/impersonation.query", () => ({
  useCanImpersonate: () => true,
  useImpersonationCandidates: () => mockImpersonationCandidates(),
  useImpersonateUser: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

const TWO_CANDIDATES = [
  {
    id: "user-1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    role: "member",
  },
  {
    id: "user-2",
    name: "Grace Hopper",
    email: "grace@example.com",
    role: null,
  },
];

beforeEach(() => {
  mockImpersonationCandidates.mockReturnValue({
    data: TWO_CANDIDATES,
    isLoading: false,
    isLoadingError: false,
    refetch: vi.fn(),
  });
  vi.mocked(useEnterpriseFeature).mockReturnValue(false);
  vi.mocked(useSmallTeamTier).mockReturnValue(
    undefined as ReturnType<typeof useSmallTeamTier>,
  );
});

describe("RolesSettingsPage", () => {
  it("tucks the role debugger behind a compact dialog trigger", async () => {
    // The trigger sits inside the roles list, which DisabledEnterpriseSection
    // renders pointer-events-none without a licence.
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
    const user = userEvent.setup();
    const { default: RolesSettingsPage } = await import("./page");

    render(<RolesSettingsPage />);

    // Closed by default — the page leads with the roles list.
    expect(
      screen.queryByTestId("user-searchable-select"),
    ).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole("button", { name: /debug a role/i }),
    );

    expect(screen.getByTestId("user-searchable-select")).toBeInTheDocument();
    expect(mockUserSearchableSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [
          {
            userId: "user-1",
            name: "Ada Lovelace · Member",
            email: "ada@example.com",
          },
          {
            userId: "user-2",
            name: "Grace Hopper",
            email: "grace@example.com",
          },
        ],
        placeholder: "Select a user",
        searchPlaceholder: "Search users by name or email",
      }),
    );
  });
  it("hides the debugger when the org has nobody to impersonate", async () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
    mockImpersonationCandidates.mockReturnValue({
      data: [],
      isLoading: false,
      isLoadingError: false,
      refetch: vi.fn(),
    });
    const { default: RolesSettingsPage } = await import("./page");

    render(<RolesSettingsPage />);

    expect(await screen.findByText("roles list")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /debug a role/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the debugger visible when the candidate fetch fails", async () => {
    // Hiding on error would make an outage look like a single-user org.
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
    mockImpersonationCandidates.mockReturnValue({
      data: [],
      isLoading: false,
      isLoadingError: true,
      refetch: vi.fn(),
    });
    const { default: RolesSettingsPage } = await import("./page");

    render(<RolesSettingsPage />);

    expect(
      await screen.findByRole("button", { name: /debug a role/i }),
    ).toBeInTheDocument();
  });
});
