import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SensitiveDataConfirmDialog } from "./sensitive-data-confirm-dialog";

describe("SensitiveDataConfirmDialog", () => {
  it("renders with the exact generic copy when open", () => {
    render(
      <SensitiveDataConfirmDialog
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Possible sensitive data detected"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your message seems to contain sensitive data, are you sure?",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send anyway" }),
    ).toBeInTheDocument();
  });

  it("fires onConfirm when Send anyway is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <SensitiveDataConfirmDialog
        open
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send anyway" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("fires onCancel when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <SensitiveDataConfirmDialog
        open
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(
      <SensitiveDataConfirmDialog
        open={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(
        "Your message seems to contain sensitive data, are you sure?",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send anyway" }),
    ).not.toBeInTheDocument();
  });
});
