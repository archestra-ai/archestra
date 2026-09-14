import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import { RuntimeCapableIndicator } from "./runtime-capable-indicator";

vi.mock("@/lib/config/config.query");

const claudeCodeRuntime = {
  image: "registry.example/team/agent-claude-code:v2",
  command: ["archestra-claude-code"],
};
const customRuntime = {
  image: "ghcr.io/example/toolbox:latest",
  command: ["python", "loop.py"],
};

describe("RuntimeCapableIndicator", () => {
  beforeEach(() => {
    vi.mocked(useFeature).mockImplementation((flag) =>
      flag === "agentRuntime" ? true : undefined,
    );
  });

  it("names a maintained template's runtime with its own mark", () => {
    render(
      <RuntimeCapableIndicator variant="pill" runtime={claudeCodeRuntime} />,
    );

    // The tooltip trigger overwrites the badge's `data-slot`; its variant
    // attribute survives.
    const pill = screen
      .getByText("Claude Code")
      .closest("[data-variant=secondary]");
    expect(pill).not.toBeNull();
    // The template's mark, not the generic terminal glyph.
    expect(pill?.querySelector("img")).not.toBeNull();
    expect(pill?.querySelector("svg")).toBeNull();
  });

  it("reads as a plain runtime for a custom image and for the platform loop", () => {
    const { rerender } = render(
      <RuntimeCapableIndicator variant="pill" runtime={customRuntime} />,
    );
    expect(screen.getByText("Runtime")).toBeInTheDocument();
    expect(screen.queryByText("Claude Code")).toBeNull();

    rerender(
      <RuntimeCapableIndicator
        variant="pill"
        runtime={{ image: "agent-archestra:dev", command: null }}
      />,
    );
    expect(screen.getByText("Runtime")).toBeInTheDocument();
  });

  it("renders nothing while the deployment's runtime feature is off", () => {
    vi.mocked(useFeature).mockReturnValue(false);

    const { container } = render(
      <RuntimeCapableIndicator variant="pill" runtime={claudeCodeRuntime} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
