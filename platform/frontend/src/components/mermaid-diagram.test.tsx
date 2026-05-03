import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light" }),
}));

import mermaid from "mermaid";
import { MermaidDiagram } from "./mermaid-diagram";

describe("MermaidDiagram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls mermaid.render with the provided chart string", async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: "<svg></svg>",
      bindFunctions: undefined,
    });

    render(<MermaidDiagram chart="graph TD; A-->B;" />);

    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalledWith(
        expect.stringContaining("mermaid-diagram"),
        "graph TD; A-->B;",
      );
    });
  });

  it("shows an error message when the diagram syntax is invalid", async () => {
    vi.mocked(mermaid.render).mockRejectedValue(
      new Error("Parse error on line 1"),
    );

    render(<MermaidDiagram chart="not valid mermaid" />);

    await waitFor(() => {
      expect(screen.getByText("Invalid diagram")).toBeInTheDocument();
      expect(screen.getByText(/Parse error on line 1/)).toBeInTheDocument();
    });
  });

  it("removes the leaked mermaid container from document.body on render error", async () => {
    vi.spyOn(Date, "now").mockReturnValue(99999);
    const leaked = document.createElement("div");
    leaked.id = "mermaid-diagram-99999";
    document.body.appendChild(leaked);

    vi.mocked(mermaid.render).mockRejectedValue(new Error("syntax error"));

    render(<MermaidDiagram chart="invalid" />);

    await waitFor(() => {
      expect(document.getElementById("mermaid-diagram-99999")).toBeNull();
    });
  });
});
