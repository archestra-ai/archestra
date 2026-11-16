import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { McpCapabilityBadges } from "./mcp-capability-badges";

describe("McpCapabilityBadges", () => {
  it("shows Apps and Skills discovered for a catalog", () => {
    render(<McpCapabilityBadges providesUi providesSkills skillCount={2} />);
    expect(screen.getByText("Apps")).toBeInTheDocument();
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByTitle("Provides 2 skills")).toBeInTheDocument();
  });
});
