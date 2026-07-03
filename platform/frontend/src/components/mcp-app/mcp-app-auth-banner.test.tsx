import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { McpAppAuthBanner } from "./mcp-app-auth-banner";

describe("McpAppAuthBanner", () => {
  it("mirrors the SDK error prose with the install URL clickable", () => {
    render(
      <McpAppAuthBanner
        toolName="slack__slack_search_channels"
        authState={{
          kind: "auth-required",
          catalogName: "Slack",
          actionUrl: "http://localhost:3000/mcp/registry?install=cat_slack",
          action: "install_mcp_credentials",
          providerId: null,
          catalogId: "cat_slack",
        }}
        onDismiss={() => {}}
      />,
    );

    expect(
      screen.getByText(
        /Tool “slack__slack_search_channels” requires authentication/,
      ),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: "http://localhost:3000/mcp/registry?install=cat_slack",
    });
    expect(link).toHaveAttribute(
      "href",
      "http://localhost:3000/mcp/registry?install=cat_slack",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("links the reauth URL for expired credentials", () => {
    render(
      <McpAppAuthBanner
        toolName="github__list_issues"
        authState={{
          kind: "auth-expired",
          catalogName: "GitHub",
          reauthUrl:
            "http://localhost:3000/mcp/registry?reauth=cat_github&server=srv_1",
          catalogId: "cat_github",
          serverId: "srv_1",
        }}
        onDismiss={() => {}}
      />,
    );

    expect(
      screen.getByText(/Tool “github__list_issues” requires re-authentication/),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: "http://localhost:3000/mcp/registry?reauth=cat_github&server=srv_1",
    });
    expect(link).toHaveAttribute(
      "href",
      "http://localhost:3000/mcp/registry?reauth=cat_github&server=srv_1",
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("fires onDismiss when the dismiss button is pressed", async () => {
    const onDismiss = vi.fn();
    render(
      <McpAppAuthBanner
        toolName="slack__slack_search_channels"
        authState={{
          kind: "auth-required",
          catalogName: "Slack",
          actionUrl: "http://localhost:3000/mcp/registry?install=cat_slack",
          action: "install_mcp_credentials",
          providerId: null,
          catalogId: "cat_slack",
        }}
        onDismiss={onDismiss}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
