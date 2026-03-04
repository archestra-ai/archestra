import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExpiredAuthTool } from "./expired-auth-tool";

describe("ExpiredAuthTool", () => {
  const defaultProps = {
    toolName: "github__list_repos",
    catalogName: "github-copilot-remote",
    manageUrl:
      "http://localhost:3000/mcp/registry?manage=cat_abc123&highlight=srv_xyz",
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

  it("renders a link to the manage URL", () => {
    render(<ExpiredAuthTool {...defaultProps} />);

    const link = screen.getByRole("link", { name: /Manage credentials/i });
    expect(link).toHaveAttribute("href", defaultProps.manageUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders with different catalog names and URLs", () => {
    render(
      <ExpiredAuthTool
        toolName="jira__create_issue"
        catalogName="jira-atlassian-remote"
        manageUrl="http://localhost:3000/mcp/registry?manage=cat_jira&highlight=srv_jira"
      />,
    );

    expect(
      screen.getByText(/credentials for.*jira-atlassian-remote.*have expired/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Manage credentials/i }),
    ).toHaveAttribute(
      "href",
      "http://localhost:3000/mcp/registry?manage=cat_jira&highlight=srv_jira",
    );
  });

  it("renders an alert element", () => {
    const { container } = render(<ExpiredAuthTool {...defaultProps} />);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeInTheDocument();
  });
});
