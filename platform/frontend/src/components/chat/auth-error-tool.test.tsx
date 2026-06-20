import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AuthErrorTool } from "./auth-error-tool";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("AuthErrorTool", () => {
  it("renders the title and description", () => {
    render(
      <AuthErrorTool
        title="Authentication Required"
        description="No credentials found for github."
      />,
    );

    expect(screen.getByText(/Authentication Required/i)).toBeInTheDocument();
    expect(
      screen.getByText(/No credentials found for github/),
    ).toBeInTheDocument();
  });

  it("renders an external link with new-tab attributes by default", () => {
    render(
      <AuthErrorTool
        title="Expired / Invalid Authentication"
        description="expired"
        buttonText="Manage credentials"
        buttonUrl="https://example.com/reauth"
      />,
    );

    const link = screen.getByRole("link", { name: /Manage credentials/i });
    expect(link).toHaveAttribute("href", "https://example.com/reauth");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("omits target/rel when openInNewTab is false (IdP connect)", () => {
    render(
      <AuthErrorTool
        title="Authentication Required"
        description="connect"
        buttonText="Connect EntraID"
        buttonUrl="https://example.com/sso"
        openInNewTab={false}
      />,
    );

    const link = screen.getByRole("link", { name: /Connect EntraID/i });
    expect(link).toHaveAttribute("href", "https://example.com/sso");
    expect(link).not.toHaveAttribute("target");
    expect(link).not.toHaveAttribute("rel");
  });

  it("renders an inline action button instead of a link when onAction is set", async () => {
    const onAction = vi.fn();
    render(
      <AuthErrorTool
        title="Expired / Invalid Authentication"
        description="expired"
        buttonText="Re-authenticate"
        buttonUrl="https://example.com/reauth"
        onAction={onAction}
        actionTooltipText="redirect tooltip"
      />,
    );

    const button = screen.getByRole("button", { name: /Re-authenticate/i });
    expect(button).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Re-authenticate/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(button);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("renders no action when there is no button text", () => {
    render(
      <AuthErrorTool
        title="Expired / Invalid Authentication"
        description="ask an admin"
      />,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("uses the items-start card shell", () => {
    const { container } = render(
      <AuthErrorTool title="Authentication Required" description="x" />,
    );

    expect(
      container.querySelector(".flex.flex-wrap.items-start"),
    ).toBeInTheDocument();
  });
});
