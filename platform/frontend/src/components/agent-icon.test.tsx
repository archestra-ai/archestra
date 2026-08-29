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
});
