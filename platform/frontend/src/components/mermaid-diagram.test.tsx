import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockUseTheme } = vi.hoisted(() => ({
  mockUseTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

const mockRender = vi.fn();
const mockInitialize = vi.fn();

vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    render: (...args: unknown[]) => mockRender(...args),
  },
}));

import { MermaidDiagram } from "./mermaid-diagram";

describe("MermaidDiagram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTheme.mockReturnValue({ theme: "light" });
  });

  it("renders a valid diagram", async () => {
    mockRender.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>',
    });

    render(<MermaidDiagram chart="graph TD; A-->B;" />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
    });
  });

  it("shows an alert with source text when rendering fails", async () => {
    mockRender.mockRejectedValue(new Error("Parse error on line 1"));

    render(<MermaidDiagram chart="not valid mermaid" />);

    await waitFor(() => {
      expect(
        screen.getByText("Diagram could not be rendered"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Parse error on line 1")).toBeInTheDocument();
    expect(screen.getByText("not valid mermaid")).toBeInTheDocument();
  });

  it("cleans up orphaned mermaid DOM elements on error", async () => {
    const orphan = document.createElement("div");
    orphan.id = "mermaid-diagram-123";
    document.body.appendChild(orphan);

    mockRender.mockImplementation(async (uid: string) => {
      // Simulate mermaid leaving an orphaned element
      const leaked = document.createElement("div");
      leaked.id = uid;
      document.body.appendChild(leaked);
      throw new Error("render failed");
    });

    render(<MermaidDiagram chart="bad" id="mermaid-diagram" />);

    await waitFor(() => {
      expect(
        screen.getByText("Diagram could not be rendered"),
      ).toBeInTheDocument();
    });

    // The orphaned element should be removed from document.body
    const leakedElements = document.querySelectorAll(
      '[id^="mermaid-diagram-"]',
    );
    // Only the pre-existing orphan from before the render call should remain
    // (the one created by mockRender should be cleaned up)
    expect(leakedElements.length).toBeLessThanOrEqual(1);

    // Clean up fixture
    orphan.remove();
  });

  it("cleans up on unmount", async () => {
    mockRender.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>',
    });

    const { unmount } = render(<MermaidDiagram chart="graph TD; A-->B;" />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
    });

    // Should not throw on unmount
    expect(() => unmount()).not.toThrow();
  });
});
