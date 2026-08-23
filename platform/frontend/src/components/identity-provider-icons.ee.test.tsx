import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IdentityProviderIcon } from "./identity-provider-icons.ee";

vi.mock("next/image", () => ({
  default: ({
    alt,
    ...props
  }: React.ComponentProps<"img"> & { alt: string }) => (
    <img alt={alt} {...props} />
  ),
}));

describe("IdentityProviderIcon", () => {
  it("uses the canonical built-in ID for brand matching", () => {
    const { rerender } = render(<IdentityProviderIcon providerId="EntraID" />);

    expect(screen.getByRole("img", { name: "Microsoft" })).toBeInTheDocument();

    rerender(<IdentityProviderIcon providerId="entraid" />);

    expect(
      screen.queryByRole("img", { name: "Microsoft" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector("svg")).toBeInTheDocument();
  });
});
