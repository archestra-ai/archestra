import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidDiagram } from "./mermaid-diagram";

const { mockInitialize, mockRender, mockUseTheme } = vi.hoisted(() => ({
  mockInitialize: vi.fn(),
  mockRender: vi.fn(),
  mockUseTheme: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

describe("MermaidDiagram", () => {
  beforeEach(() => {
    mockUseTheme.mockReturnValue({ theme: "light" });
    vi.spyOn(Date, "now").mockReturnValue(1234);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockInitialize.mockReset();
    mockRender.mockReset();
    mockUseTheme.mockReset();
    document.body.replaceChildren();
  });

  it("renders a Mermaid SVG when the diagram is valid", async () => {
    mockRender.mockResolvedValueOnce({
      svg: '<svg viewBox="0 0 100 50"><text>Rendered diagram</text></svg>',
    });

    const { container } = render(
      <MermaidDiagram chart="graph TD; A-->B;" id="test-mermaid" />,
    );

    await waitFor(() => {
      expect(container.querySelector("svg")).not.toBeNull();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockRender).toHaveBeenCalledWith(
      "test-mermaid-1234",
      "graph TD; A-->B;",
    );
  });

  it("displays the parse error and removes Mermaid scratch DOM on invalid diagrams", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockRender.mockImplementationOnce(async (uniqueId: string) => {
      const scratch = document.createElement("div");
      scratch.id = uniqueId;
      scratch.textContent = "leaked scratch element";
      document.body.appendChild(scratch);
      throw new Error("Parse error on line 2");
    });

    render(<MermaidDiagram chart="graph TD; A-->" id="broken-mermaid" />);

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent("Unable to render Mermaid diagram");
    expect(alert).toHaveTextContent("Parse error on line 2");
    expect(document.getElementById("broken-mermaid-1234")).toBeNull();
    expect(screen.queryByText("graph TD; A-->")).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "Error rendering mermaid diagram:",
      expect.any(Error),
    );
  });
});
