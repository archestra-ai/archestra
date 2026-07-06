import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SecretInput } from "./secret-input";

describe("SecretInput", () => {
  it("masks the value by default and renders no reveal toggle", () => {
    render(<SecretInput aria-label="secret" defaultValue="sk-ant-123" />);

    expect(screen.getByLabelText("secret")).toHaveClass("secret-masked");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("reveals and re-hides the value via the eye toggle when revealable", async () => {
    const user = userEvent.setup();
    render(
      <SecretInput aria-label="secret" revealable defaultValue="sk-ant-123" />,
    );

    const input = screen.getByLabelText("secret");
    // Masked by default even when revealable.
    expect(input).toHaveClass("secret-masked");

    await user.click(screen.getByRole("button", { name: "Show value" }));
    expect(input).not.toHaveClass("secret-masked");

    await user.click(screen.getByRole("button", { name: "Hide value" }));
    expect(input).toHaveClass("secret-masked");
  });

  it("never masks with type=password so browser password managers stay away", () => {
    render(<SecretInput aria-label="secret" revealable defaultValue="x" />);

    expect(screen.getByLabelText("secret")).toHaveAttribute("type", "text");
  });
});
