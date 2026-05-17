import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangePasswordDialog } from "./change-password-dialog";

const mockChangePasswordMutateAsync = vi.fn();

vi.mock("@/lib/auth/account.query", () => ({
  useChangeAccountPasswordMutation: () => ({
    mutateAsync: mockChangePasswordMutateAsync,
    isPending: false,
  }),
}));

describe("ChangePasswordDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChangePasswordMutateAsync.mockResolvedValue(true);
  });

  it("submits the current and new password", async () => {
    const onOpenChange = vi.fn();

    render(<ChangePasswordDialog open onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "old-password" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "new-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(mockChangePasswordMutateAsync).toHaveBeenCalledWith({
        currentPassword: "old-password",
        newPassword: "new-password",
        revokeOtherSessions: true,
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
