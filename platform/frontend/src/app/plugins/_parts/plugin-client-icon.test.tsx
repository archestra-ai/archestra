import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PluginClientIcon } from "./plugin-client-icon";

describe("PluginClientIcon", () => {
  it.each([
    ["claude-code", "Anthropic"],
    ["claude-desktop", "Anthropic"],
    ["codex", "OpenAI"],
    ["cursor", "Cursor"],
  ])("draws a logo for %s", (clientType, alt) => {
    render(<PluginClientIcon clientType={clientType} />);
    expect(screen.getByRole("img", { name: alt })).toBeInTheDocument();
  });
});
