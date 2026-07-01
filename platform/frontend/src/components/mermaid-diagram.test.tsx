import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidDiagram } from "./mermaid-diagram";

// jsdom has no SVG layout (getBBox), so mermaid never completes a *successful*
// render here — every chart ends in the failure path. That is exactly the path
// this bug lives on, so these tests exercise it directly. The success path is
// verified against a real browser instead.
const INVALID_CHART = "graph TD; A-->; --> this is not valid mermaid @@@";

// Mermaid appends a temporary render scratch element (`<div id="d<renderId>">`)
// to document.body while drawing. On a failed render it must still be removed;
// the bug left it orphaned on document.body, outside React's tree.
function leakedMermaidScratchNodes(): NodeListOf<Element> {
  return document.body.querySelectorAll('div[id^="dmermaid"]');
}

afterEach(() => {
  // Scratch nodes live on document.body (outside RTL's container), so RTL
  // cleanup won't remove them — clear strays so a leak can't bleed between tests.
  for (const el of Array.from(leakedMermaidScratchNodes())) {
    el.remove();
  }
});

describe("MermaidDiagram (invalid diagram handling)", () => {
  it("does not leak mermaid's temp render node onto document.body", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<MermaidDiagram chart={INVALID_CHART} />);

    // Settle: the render attempt has failed and been handled by the catch.
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "Error rendering mermaid diagram:",
        expect.anything(),
      ),
    );

    expect(leakedMermaidScratchNodes()).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it("shows a friendly error message instead of the raw diagram source", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<MermaidDiagram chart={INVALID_CHART} />);

    expect(
      await screen.findByText(/couldn't render the diagram/i),
    ).toBeInTheDocument();
  });
});
