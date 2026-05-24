import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RolePermissionsCard } from "@/components/settings/role-permissions-card";
import { useSession } from "@/lib/auth/auth.query";

const mockUpdateNameMutateAsync = vi.fn();

vi.mock("@/lib/auth/account.query", () => ({
  useUpdateAccountNameMutation: () => ({
    mutateAsync: mockUpdateNameMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useAllPermissions: () => ({
    data: null,
    isLoading: false,
  }),
  useSession: vi.fn(),
}));

vi.mock("@/lib/organization.query", () => ({
  useActiveOrganization: () => ({
    data: { id: "org-1" },
  }),
  useActiveMemberRole: () => ({
    data: "admin",
    isLoading: false,
  }),
}));

describe("RolePermissionsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateNameMutateAsync.mockResolvedValue(true);
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
