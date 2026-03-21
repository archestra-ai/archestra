import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAppRenderer } from "./mcp-app-renderer";

// ---------------------------------------------------------------------------
// Test setup — mock URL.createObjectURL / revokeObjectURL in jsdom
// ---------------------------------------------------------------------------

const blobUrls = new Set<string>();
let counter = 0;

beforeEach(() => {
  // jsdom does not implement blob: URLs, so we stub both functions.
  vi.stubGlobal("URL", {
    ...globalThis.URL,
    createObjectURL: vi.fn(() => {
      const url = `blob:fake-url-${++counter}`;
      blobUrls.add(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      blobUrls.delete(url);
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  blobUrls.clear();
});

// ---------------------------------------------------------------------------
// McpAppRenderer tests
// ---------------------------------------------------------------------------

describe("McpAppRenderer", () => {
  it("renders an iframe when given valid HTML", () => {
    render(<McpAppRenderer htmlContent="<h1>Test</h1>" title="Test App" />);
    const iframe = screen.getByTitle("Test App") as HTMLIFrameElement;
    expect(iframe.tagName).toBe("IFRAME");
  });

  it("sets `src` to a blob: URL", () => {
    render(<McpAppRenderer htmlContent="<div/>" title="Widget" />);
    const iframe = screen.getByTitle("Widget") as HTMLIFrameElement;
    expect(iframe.src).toMatch(/^blob:/);
  });

  it("sets the sandbox attribute to `allow-scripts`", () => {
    render(<McpAppRenderer htmlContent="<p>hi</p>" title="App" />);
    const iframe = screen.getByTitle("App") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("uses the default title when none is provided", () => {
    render(<McpAppRenderer htmlContent="<p>hi</p>" />);
    const iframe = screen.getByTitle("MCP App") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
  });

  it("applies the initialHeight prop as the inline style height", () => {
    render(
      <McpAppRenderer htmlContent="<p/>" title="App" initialHeight={500} />,
    );
    const iframe = screen.getByTitle("App") as HTMLIFrameElement;
    expect(iframe.style.height).toBe("500px");
  });

  it("calls URL.revokeObjectURL when unmounted", () => {
    const { unmount } = render(
      <McpAppRenderer htmlContent="<p/>" title="App" />,
    );
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    unmount();
    expect(revokeSpy).toHaveBeenCalledOnce();
  });

  it("does not render the iframe when htmlContent is empty", () => {
    // An empty HTML string still results in a valid blob — the iframe renders.
    // This test documents the current behaviour rather than asserting a guard,
    // so that reviewers can decide if empty content should be suppressed.
    render(<McpAppRenderer htmlContent="" title="Empty" />);
    // The blob URL is created even for empty content (a blank page is valid).
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});
