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

vi.mock("@/lib/config/config.query");

vi.mock("@/components/roles/roles-list.ee", () => ({
  RolesList: () => <div>roles list</div>,
}));

vi.mock("@/components/user-searchable-select", () => ({
  UserSearchableSelect: (
    props: Parameters<typeof mockUserSearchableSelect>[0],
  ) => mockUserSearchableSelect(props),
}));

vi.mock("@/lib/impersonation.query", () => ({
  useCanImpersonate: () => true,
  useImpersonationCandidates: () => ({
    data: [
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
    ],
    isLoading: false,
  }),
  useImpersonateUser: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

beforeEach(() => {
  vi.mocked(useEnterpriseFeature).mockReturnValue(false);
  vi.mocked(useSmallTeamTier).mockReturnValue(
    undefined as ReturnType<typeof useSmallTeamTier>,
  );
});

describe("RolesSettingsPage", () => {
  it("tucks the role debugger behind a compact popover trigger", async () => {
    const user = userEvent.setup();
    const { default: RolesSettingsPage } = await import("./page");

    render(<RolesSettingsPage />);

    // Collapsed by default — the page leads with the roles list.
    expect(
      screen.queryByTestId("user-searchable-select"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /debug a role/i }));

    expect(screen.getByTestId("user-searchable-select")).toBeInTheDocument();
    expect(mockUserSearchableSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [
          {
            userId: "user-1",
            name: "Ada Lovelace · member",
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
});
