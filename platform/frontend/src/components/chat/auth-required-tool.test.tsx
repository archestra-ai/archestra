import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthRequiredTool } from "./auth-required-tool";

describe("AuthRequiredTool", () => {
  const defaultProps = {
    toolName: "jira__create_issue",
    catalogName: "jira-atlassian-remote",
    installUrl: "http://localhost:3000/mcp/registry?install=cat_abc123",
  };

  it("renders the Authentication Required alert", () => {
    render(<AuthRequiredTool {...defaultProps} />);

    expect(screen.getByText("Authentication Required")).toBeInTheDocument();
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
    expect(link).toHaveAttribute("href", defaultProps.installUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders with different catalog names and URLs", () => {
    render(
      <AuthRequiredTool
        toolName="github__list_repos"
        catalogName="github-remote"
        installUrl="http://localhost:3000/mcp/registry?install=cat_xyz"
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
});
