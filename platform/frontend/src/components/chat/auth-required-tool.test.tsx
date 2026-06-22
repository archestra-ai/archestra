import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthRequiredTool } from "./auth-required-tool";

describe("AuthRequiredTool", () => {
  const defaultProps = {
    toolName: "jira__create_issue",
    catalogName: "jira-atlassian-remote",
    action: "install_mcp_credentials" as const,
    actionUrl: "http://localhost:3000/mcp/registry?install=cat_abc123",
  };

  it("renders the Authentication Required alert", () => {
    render(<AuthRequiredTool {...defaultProps} />);

    expect(screen.getByText(/Authentication Required/i)).toBeInTheDocument();
  });

  it("displays the catalog name in the description", () => {
    render(<AuthRequiredTool {...defaultProps} />);

    expect(
      screen.getByText(/No credentials found for.*jira-atlassian-remote/),
    ).toBeInTheDocument();
  });

  it("renders a link to the install URL", () => {
    render(<AuthRequiredTool {...defaultProps} />);

    const link = screen.getByRole("link", { name: /Set up credentials/i });
    expect(link).toHaveAttribute("href", defaultProps.actionUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders with different catalog names and URLs", () => {
    render(
      <AuthRequiredTool
        toolName="github__list_repos"
        catalogName="github-remote"
        action="install_mcp_credentials"
        actionUrl="http://localhost:3000/mcp/registry?install=cat_xyz"
      />,
    );

    expect(
      screen.getByText(/No credentials found for.*github-remote/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Set up credentials/i }),
    ).toHaveAttribute(
      "href",
      "http://localhost:3000/mcp/registry?install=cat_xyz",
    );
  });

  it("renders an inline button when onInstall is provided", () => {
    render(<AuthRequiredTool {...defaultProps} onInstall={() => {}} />);

    const button = screen.getByRole("button", {
      name: /Set up credentials/i,
    });
    expect(button).toBeInTheDocument();
    // Should not render a link
    expect(
      screen.queryByRole("link", { name: /Set up credentials/i }),
    ).not.toBeInTheDocument();
  });

  it("calls onInstall when the inline button is clicked", async () => {
    const onInstall = vi.fn();
    render(<AuthRequiredTool {...defaultProps} onInstall={onInstall} />);

    await userEvent.click(
      screen.getByRole("button", { name: /Set up credentials/i }),
    );
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it("renders a linked identity provider action as a direct link", () => {
    render(
      <AuthRequiredTool
        toolName="debug_auth_token"
        catalogName="protected-api"
        action="connect_identity_provider"
        actionUrl="http://localhost:3000/auth/sso/EntraID?redirectTo=%2Fchat%2Fconv-123"
        providerId="EntraID"
        onInstall={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Connect EntraID\. This deployment can then request/),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Connect EntraID/i });
    expect(link).toHaveAttribute(
      "href",
      "http://localhost:3000/auth/sso/EntraID?redirectTo=%2Fchat%2Fconv-123",
    );
    expect(link).not.toHaveAttribute("target");
    expect(link).not.toHaveAttribute("rel");
    expect(
      screen.queryByRole("button", { name: /Connect EntraID/i }),
    ).not.toBeInTheDocument();
  });
});
