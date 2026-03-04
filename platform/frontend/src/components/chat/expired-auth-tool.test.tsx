import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExpiredAuthTool } from "./expired-auth-tool";

describe("ExpiredAuthTool", () => {
  const defaultProps = {
    toolName: "github__list_repos",
    catalogName: "github-copilot-remote",
    reauthUrl:
      "http://localhost:3000/mcp/registry?reauth=cat_abc123&server=srv_xyz",
  };

  it("renders the Expired / Invalid Authentication alert", () => {
    render(<ExpiredAuthTool {...defaultProps} />);

    expect(
      screen.getByText("Expired / Invalid Authentication"),
    ).toBeInTheDocument();
  });

  it("displays the catalog name in the description", () => {
    render(<ExpiredAuthTool {...defaultProps} />);

    expect(
      screen.getByText(/credentials for.*github-copilot-remote.*have expired/),
    ).toBeInTheDocument();
  });

  it("renders a link to the manage URL when no onReauth", () => {
    render(<ExpiredAuthTool {...defaultProps} />);

    const link = screen.getByRole("link", { name: /Manage credentials/i });
    expect(link).toHaveAttribute("href", defaultProps.reauthUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders with different catalog names and URLs", () => {
    render(
      <ExpiredAuthTool
        toolName="jira__create_issue"
        catalogName="jira-atlassian-remote"
        reauthUrl="http://localhost:3000/mcp/registry?reauth=cat_jira&server=srv_jira"
      />,
    );

    expect(
      screen.getByText(/credentials for.*jira-atlassian-remote.*have expired/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Manage credentials/i }),
    ).toHaveAttribute(
      "href",
      "http://localhost:3000/mcp/registry?reauth=cat_jira&server=srv_jira",
    );
  });

  it("renders an alert element", () => {
    const { container } = render(<ExpiredAuthTool {...defaultProps} />);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeInTheDocument();
  });

  it("renders a Re-authenticate button when onReauth is provided", () => {
    render(<ExpiredAuthTool {...defaultProps} onReauth={() => {}} />);

    const button = screen.getByRole("button", {
      name: /Re-authenticate/i,
    });
    expect(button).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Manage credentials/i }),
    ).not.toBeInTheDocument();
  });

  it("calls onReauth when the inline button is clicked", async () => {
    const onReauth = vi.fn();
    render(<ExpiredAuthTool {...defaultProps} onReauth={onReauth} />);

    await userEvent.click(
      screen.getByRole("button", { name: /Re-authenticate/i }),
    );
    expect(onReauth).toHaveBeenCalledOnce();
  });
});
