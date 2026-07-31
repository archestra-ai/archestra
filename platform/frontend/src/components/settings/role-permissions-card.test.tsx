import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RolePermissionsCard } from "@/components/settings/role-permissions-card";
import { useAllPermissions, useSession } from "@/lib/auth/auth.query";
import {
  useActiveMemberRole,
  useActiveOrganization,
} from "@/lib/organization.query";

const mockUpdateNameMutateAsync = vi.fn();

vi.mock("@/lib/auth/account.query", () => ({
  useUpdateAccountNameMutation: () => ({
    mutateAsync: mockUpdateNameMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/organization.query");

describe("RolePermissionsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateNameMutateAsync.mockResolvedValue(true);
    vi.mocked(useAllPermissions).mockReturnValue({
      data: null,
      isLoading: false,
    } as unknown as ReturnType<typeof useAllPermissions>);
    vi.mocked(useActiveOrganization).mockReturnValue({
      data: { id: "org-1" },
    } as unknown as ReturnType<typeof useActiveOrganization>);
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: "admin",
      isLoading: false,
    } as unknown as ReturnType<typeof useActiveMemberRole>);
    vi.mocked(useSession).mockReturnValue({
      data: {
        user: {
          id: "user-1",
          name: "Original Name",
          email: "admin@example.com",
        },
      },
    } as unknown as ReturnType<typeof useSession>);
  });

  it("keeps the skeleton up while the organization is still resolving", () => {
    vi.mocked(useActiveOrganization).mockReturnValue({
      data: undefined,
      isPending: true,
    } as unknown as ReturnType<typeof useActiveOrganization>);
    // A dependent query that is still disabled reports isLoading false with no
    // data, so the gate cannot rely on isLoading alone.
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: true,
    } as unknown as ReturnType<typeof useActiveMemberRole>);

    const { container } = render(<RolePermissionsCard />);

    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Original Name")).toBeNull();
  });

  it("keeps the skeleton up until the role arrives for a resolved organization", () => {
    // isLoading false with no data covers both halves of the wait: the query
    // still disabled, and the moment it enables. Gating on isLoading renders
    // the card here and then snaps it back to a skeleton.
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: true,
    } as unknown as ReturnType<typeof useActiveMemberRole>);

    const { container } = render(<RolePermissionsCard />);

    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Original Name")).toBeNull();
  });

  it("renders the account details when the user has no active organization", () => {
    vi.mocked(useActiveOrganization).mockReturnValue({
      data: null,
      isPending: false,
    } as unknown as ReturnType<typeof useActiveOrganization>);
    // With no organization id the role query never enables, so it stays pending
    // forever — the card must not wait on it.
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: true,
    } as unknown as ReturnType<typeof useActiveMemberRole>);

    render(<RolePermissionsCard />);

    expect(screen.getByText("Original Name")).toBeInTheDocument();
  });

  it("updates the account name from the top account section", async () => {
    render(<RolePermissionsCard />);

    expect(screen.getByText("Original Name")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    expect(screen.getByRole("textbox")).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Updated Name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => {
      expect(mockUpdateNameMutateAsync).toHaveBeenCalledWith("Updated Name");
    });
  });
});
