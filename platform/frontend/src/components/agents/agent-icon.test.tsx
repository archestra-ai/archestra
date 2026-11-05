import { APPA_KEEPER_AGENT_ICON } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentIcon } from "./agent-icon";

describe("AgentIcon", () => {
  it("renders an image path as an image", () => {
    const { container } = render(
      <AgentIcon icon="/uploads/team-logo.png" size={24} />,
    );

    expect(screen.getByRole("img", { name: "Agent icon" })).toBeVisible();
    expect(container).not.toHaveTextContent("/uploads/team-logo.png");
  });

  it("draws an agent catalog icon as the template's logo, not its file", () => {
    render(<AgentIcon icon="/agent-logos/opencode.svg" size={20} />);

    expect(screen.getByRole("img", { name: "OpenCode logo" })).toBeVisible();
    expect(screen.queryByRole("img", { name: "Agent icon" })).toBeNull();
  });

  it("renders a built-in service logo token as an SVG mark, not literal text", () => {
    const { container } = render(<AgentIcon icon="logo:github" size={20} />);

    expect(container.querySelector("svg > path")).not.toBeNull();
    expect(container).not.toHaveTextContent("logo:github");
  });

  it("keeps an emoji in a square box of the requested size", () => {
    render(<AgentIcon icon="🤖" size={20} />);

    expect(screen.getByText("🤖")).toHaveStyle({
      width: "20px",
      height: "20px",
    });
  });

  it("keeps a non-square logo in a square box", () => {
    render(<AgentIcon icon="/uploads/tall-logo.svg" size={20} />);

    expect(screen.getByRole("img", { name: "Agent icon" })).toHaveClass(
      "aspect-square",
    );
  });

  it("draws the APPA Keeper for its icon token, not literal text", () => {
    const { container } = render(
      <AgentIcon icon={APPA_KEEPER_AGENT_ICON} size={20} />,
    );

    expect(container.querySelector("svg > rect")).not.toBeNull();
    expect(container).not.toHaveTextContent(APPA_KEEPER_AGENT_ICON);
  });
});
