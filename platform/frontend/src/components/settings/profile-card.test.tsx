import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileCard } from "@/components/settings/profile-card";
import { useSession } from "@/lib/auth/auth.query";
import { useActiveMemberRole } from "@/lib/organization.query";

const mockUpdateNameMutateAsync = vi.fn();

vi.mock("@/lib/auth/account.query", () => ({
  useUpdateAccountNameMutation: () => ({
    mutateAsync: mockUpdateNameMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/organization.query");

describe("ProfileCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateNameMutateAsync.mockResolvedValue(true);
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: "admin",
      isPending: false,
    } as unknown as ReturnType<typeof useActiveMemberRole>);
    vi.mocked(useSession).mockReturnValue({
      data: {
        user: {
          id: "user-1",
          name: "Original Name",
          email: "admin@example.com",
        },
        session: { activeOrganizationId: "org-1" },
      },
      isPending: false,
    } as unknown as ReturnType<typeof useSession>);
  });

  it("keeps the skeleton up while the session is still resolving", () => {
    vi.mocked(useSession).mockReturnValue({
      data: undefined,
      isPending: true,
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: undefined,
      isPending: true,
    } as unknown as ReturnType<typeof useActiveMemberRole>);

    const { container } = render(<ProfileCard />);

    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByDisplayValue("Original Name")).toBeNull();
  });

  it("keeps the skeleton up until the role arrives when the session has an active organization", () => {
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: undefined,
      isPending: true,
    } as unknown as ReturnType<typeof useActiveMemberRole>);

    const { container } = render(<ProfileCard />);

    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
  });

  it("renders the account details when the user has no active organization", () => {
    vi.mocked(useSession).mockReturnValue({
      data: {
        user: {
          id: "user-1",
          name: "Original Name",
          email: "admin@example.com",
        },
        session: { activeOrganizationId: null },
      },
      isPending: false,
    } as unknown as ReturnType<typeof useSession>);
    // With no active organization the role query never enables, so it stays
    // pending forever — the card must not wait on it.
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: undefined,
      isPending: true,
    } as unknown as ReturnType<typeof useActiveMemberRole>);

    render(<ProfileCard />);

    expect(screen.getByLabelText("Name")).toHaveValue("Original Name");
  });

  it("shows the name beside the avatar", () => {
    render(<ProfileCard />);

    // Distinct from the editable field below, which holds the same value.
    expect(screen.getByText("Original Name")).toBeInTheDocument();
  });

  it("keeps email and role as read-only fields", () => {
    render(<ProfileCard />);

    const email = screen.getByLabelText("Email");
    expect(email).toHaveValue("admin@example.com");
    expect(email).toHaveAttribute("readonly");

    const role = screen.getByLabelText("Role");
    expect(role).toHaveValue("admin");
    expect(role).toHaveAttribute("readonly");

    expect(screen.getByLabelText("Name")).not.toHaveAttribute("readonly");
  });

  it("submits a changed name and keeps the button idle until it changes", async () => {
    render(<ProfileCard />);

    const submit = screen.getByRole("button", { name: "Update profile" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Updated Name" },
    });
    await waitFor(() => expect(submit).toBeEnabled());

    fireEvent.click(submit);

    await waitFor(() => {
      expect(mockUpdateNameMutateAsync).toHaveBeenCalledWith("Updated Name");
    });
  });
});
