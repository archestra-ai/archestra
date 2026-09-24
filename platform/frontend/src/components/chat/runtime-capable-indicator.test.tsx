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

  it("names a maintained template's runtime", () => {
    render(
      <RuntimeCapableIndicator variant="pill" runtime={claudeCodeRuntime} />,
    );

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });

  it("reads as a plain runtime for a custom image, with or without a command", () => {
    const { rerender } = render(
      <RuntimeCapableIndicator variant="pill" runtime={customRuntime} />,
    );
    expect(screen.getByText("Runtime")).toBeInTheDocument();

    rerender(
      <RuntimeCapableIndicator
        variant="pill"
        runtime={{ image: "ghcr.io/example/toolbox:latest", command: null }}
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
