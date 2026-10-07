import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthMethodPicker } from "./connect-rail";

const METHODS = [
  {
    value: "standard",
    title: "Standard virtual key",
    description: "One key per client.",
    manage: { label: "Manage virtual keys", href: "/keys" },
  },
  {
    value: "oauth",
    title: "OAuth client",
    description: "Client credentials.",
    manage: { label: "Manage OAuth clients", href: "/oauth" },
  },
];

describe("AuthMethodPicker", () => {
  it("selects a method from its card but not from its manage link", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AuthMethodPicker
        methods={METHODS}
        value="standard"
        onChange={onChange}
      />,
    );

    await user.click(
      screen.getByRole("link", { name: /Manage OAuth clients/ }),
    );
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByText("OAuth client"));
    expect(onChange).toHaveBeenCalledWith("oauth");
  });
});
