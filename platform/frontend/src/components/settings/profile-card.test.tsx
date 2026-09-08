import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileCard } from "@/components/settings/profile-card";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
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
    // The save bar's button runs through PermissionButton; the profile edit has
    // no RBAC gate ({} permissions), so it is always granted.
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
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

  it("shows the name once, in the field that edits it", () => {
    render(<ProfileCard />);

    expect(screen.getByLabelText("Name")).toHaveValue("Original Name");
    // Not repeated as static text beside the avatar.
    expect(screen.queryByText("Original Name")).toBeNull();
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

  it("says why each locked field is locked", () => {
    render(<ProfileCard />);

    expect(
      screen.getByText("The address you sign in with. It can't be changed."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Set by an organization admin. You can't change your own role.",
      ),
    ).toBeVisible();
  });

  it("hides the save bar until the name changes, then saves through it", async () => {
    render(<ProfileCard />);

    // The footer save bar stays out of the way until there is something to
    // save — no Save control on first paint.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Updated Name" },
    });

    const save = await screen.findByRole("button", { name: "Save" });
    expect(save).toBeEnabled();

    fireEvent.click(save);

    await waitFor(() => {
      expect(mockUpdateNameMutateAsync).toHaveBeenCalledWith("Updated Name");
    });
  });

  it("drops the change and hides the save bar again on cancel", async () => {
    render(<ProfileCard />);

    const nameField = screen.getByLabelText("Name");
    fireEvent.change(nameField, { target: { value: "Half-typed" } });

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    // Cancel reverts to the saved name and pulls the bar back down without
    // calling the mutation.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
    );
    expect(nameField).toHaveValue("Original Name");
    expect(mockUpdateNameMutateAsync).not.toHaveBeenCalled();
  });
});
