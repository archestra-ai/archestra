import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { PlatformTokenCard } from "./platform-token-card";

describe("PlatformTokenCard", () => {
  it("renders existing tokens as a compact header with the action aligned to the copy", () => {
    const { container } = render(
      <PlatformTokenCard
        title="MCP Gateway/A2A Gateway Token"
        description="Your personal token to authenticate with Agents / MCP Gateways."
        isLoading={false}
        tokenExists
        emptyDescription="No token has been created."
        action={<Button>Manage Token</Button>}
      />,
    );

    expect(
      screen.getByText(
        "Your personal token to authenticate with Agents / MCP Gateways.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage Token" })).toBeVisible();
    expect(
      screen.queryByText("Manage token value, rotation, and usage details."),
    ).not.toBeInTheDocument();
    expect(container.querySelector(".items-center")).toBeTruthy();
  });
});
