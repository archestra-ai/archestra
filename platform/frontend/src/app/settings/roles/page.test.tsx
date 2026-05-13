"use client";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/config/config", () => ({
  default: {
    enterpriseFeatures: {
      core: false,
    },
  },
}));

vi.mock("@/components/roles/roles-list", () => ({
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

describe("RolesSettingsPage", () => {
  it("uses the searchable user select for role debugging", async () => {
    const { default: RolesSettingsPage } = await import("./page");

    render(<RolesSettingsPage />);

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
