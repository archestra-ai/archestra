import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseTheme, mockInitialize, mockParse, mockRender } = vi.hoisted(
  () => ({
    mockUseTheme: vi.fn(() => ({ theme: "light" })),
    mockInitialize: vi.fn(),
    mockParse: vi.fn(),
    mockRender: vi.fn(),
  }),
);

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: mockInitialize,
    parse: mockParse,
    render: mockRender,
  },
}));

import { MermaidDiagram } from "./mermaid-diagram";

describe("MermaidDiagram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.replaceChildren();
  });

  it("initializes mermaid with suppressErrorRendering enabled", async () => {
    mockParse.mockResolvedValue({ diagramType: "flowchart", config: {} });
    mockRender.mockResolvedValue({ svg: "<svg></svg>" });

    render(<MermaidDiagram chart="graph TD; A-->B" />);

    await waitFor(() => expect(mockInitialize).toHaveBeenCalled());
    const config = mockInitialize.mock.calls[0]?.[0];
    expect(config).toMatchObject({ suppressErrorRendering: true });
  });

  it("validates with mermaid.parse before rendering", async () => {
    mockParse.mockResolvedValue({ diagramType: "flowchart", config: {} });
    mockRender.mockResolvedValue({ svg: "<svg></svg>" });

    render(<MermaidDiagram chart="graph TD; A-->B" />);

    await waitFor(() =>
      expect(mockParse).toHaveBeenCalledWith("graph TD; A-->B", {
        suppressErrors: true,
      }),
    );
    await waitFor(() => expect(mockRender).toHaveBeenCalled());
  });

  it("shows inline error and skips render when parse returns false", async () => {
    mockParse.mockResolvedValue(false);

    const { container } = render(
      <MermaidDiagram chart="not valid mermaid" />,
    );

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Invalid mermaid diagram syntax",
      ),
    );
    expect(mockRender).not.toHaveBeenCalled();
    // Original chart text is still surfaced for debugging
    expect(container.textContent).toContain("not valid mermaid");
  });

  it("shows inline error when parse throws", async () => {
    mockParse.mockRejectedValue(new Error("parse blew up"));

    const { container } = render(<MermaidDiagram chart="???" />);

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Invalid mermaid diagram syntax",
      ),
    );
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("shows inline error when render throws after a successful parse", async () => {
    mockParse.mockResolvedValue({ diagramType: "flowchart", config: {} });
    mockRender.mockRejectedValue(new Error("render blew up"));

    const { container } = render(
      <MermaidDiagram chart="graph TD; A-->B" />,
    );

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Failed to render mermaid diagram",
      ),
    );
  });
});
