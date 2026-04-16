import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const { mockUseTheme } = vi.hoisted(() => ({
  mockUseTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

vi.mock("react-syntax-highlighter", () => ({
  Prism: ({ children }: { children: string }) => (
    <pre data-testid="syntax-highlighter">
      <code>{children}</code>
    </pre>
  ),
}));

vi.mock("react-syntax-highlighter/dist/esm/styles/prism", () => ({
  oneDark: {},
  oneLight: {},
}));

vi.mock("@/components/mermaid-diagram", () => ({
  MermaidDiagram: ({ chart }: { chart: string }) => (
    <div data-testid="mermaid-diagram">{chart}</div>
  ),
}));

import { ConversationArtifactPanel } from "./conversation-artifact";

function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("ConversationArtifactPanel", () => {
  it("renders a copy button inside fenced code blocks", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });

    render(
      <ConversationArtifactPanel
        artifact={"```js\nconst x = 1;\n```"}
        isOpen
        onToggle={() => {}}
      />,
    );

    // The panel header already has a "copy entire artifact" button; the new
    // per-block copy button means at least 2 buttons share this name.
    const copyButtons = screen.getAllByRole("button", {
      name: /copy to clipboard/i,
    });
    expect(copyButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("copies fenced code via the code block copy button", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(
      <ConversationArtifactPanel
        artifact={"```js\nconst x = 1;\n```"}
        isOpen
        onToggle={() => {}}
      />,
    );

    // Panel-header copy comes first in DOM order; the code-block copy is last.
    const copyButtons = screen.getAllByRole("button", {
      name: /copy to clipboard/i,
    });
    await user.click(copyButtons[copyButtons.length - 1]);

    expect(writeText).toHaveBeenCalledWith("const x = 1;");
  });

  it("still routes mermaid code blocks to the mermaid renderer", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });

    render(
      <ConversationArtifactPanel
        artifact={"```mermaid\ngraph TD; A-->B;\n```"}
        isOpen
        onToggle={() => {}}
      />,
    );

    expect(screen.getByTestId("mermaid-diagram")).toBeInTheDocument();
  });
});
