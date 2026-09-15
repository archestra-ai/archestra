import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentIcon } from "./agent-icon";

describe("AgentIcon", () => {
  it("renders a catalog asset path as an image", () => {
    const { container } = render(
      <AgentIcon icon="/agent-logos/hermes.png" size={24} />,
    );

    expect(screen.getByRole("img", { name: "Agent icon" })).toBeVisible();
    expect(container).not.toHaveTextContent("/agent-logos/hermes.png");
  });

  it("renders a built-in service logo token as an SVG mark, not literal text", () => {
    const { container } = render(<AgentIcon icon="logo:github" size={20} />);

    expect(container.querySelector("svg > path")).not.toBeNull();
    expect(container).not.toHaveTextContent("logo:github");
  });
});
