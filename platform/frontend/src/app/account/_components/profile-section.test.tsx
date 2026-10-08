import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { ProfileSection } from "./profile-section";

const mockUpdateNameMutateAsync = vi.fn();

vi.mock("@/lib/auth/account.query", () => ({
  useUpdateAccountNameMutation: () => ({
    mutateAsync: mockUpdateNameMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query");

describe("ProfileSection", () => {
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

    const { container } = render(<ProfileSection />);

    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Original Name")).toBeNull();
  });

  it("shows who you are as read-only text, with no open inputs", () => {
    render(<ProfileSection />);

    expect(screen.getByText("Original Name")).toBeVisible();
    expect(screen.getByText("admin@example.com")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renames through the Edit name dialog", async () => {
    const user = userEvent.setup();
    render(<ProfileSection />);

    await user.click(screen.getByRole("button", { name: "Edit name" }));
    const field = screen.getByLabelText("Name");
    expect(field).toHaveValue("Original Name");
    // Nothing to save until the name actually changes.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.clear(field);
    await user.type(field, "Updated Name");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockUpdateNameMutateAsync).toHaveBeenCalledWith("Updated Name"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("rejects an empty name without saving", async () => {
    const user = userEvent.setup();
    render(<ProfileSection />);

    await user.click(screen.getByRole("button", { name: "Edit name" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Name is required")).toBeVisible();
    expect(mockUpdateNameMutateAsync).not.toHaveBeenCalled();
  });
});
