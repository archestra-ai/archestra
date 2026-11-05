import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/config.query", () => ({ useFeature: vi.fn() }));

import { useFeature } from "@/lib/config/config.query";
import { McpCapabilityBadges } from "./mcp-capability-badges";

beforeEach(() => vi.mocked(useFeature).mockReturnValue(true));

describe("McpCapabilityBadges", () => {
  it("shows Apps and Skills discovered for a catalog", () => {
    render(<McpCapabilityBadges providesUi providesSkills skillCount={2} />);
    expect(screen.getByText("Apps")).toBeInTheDocument();
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByTitle("Provides 2 skills")).toBeInTheDocument();
  });

  it("hides Skills while the beta gate is off", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    render(<McpCapabilityBadges providesUi providesSkills skillCount={2} />);
    expect(screen.getByText("Apps")).toBeInTheDocument();
    expect(screen.queryByText("Skills")).toBeNull();
  });
});
