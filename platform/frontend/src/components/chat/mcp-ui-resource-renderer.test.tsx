import React from 'react';
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { UIActionResult, UIResourceContent } from "@shared/mcp-ui.types";

// Mock sonner
vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
  },
}));

describe("McpUIResourceRenderer", () => {
  const resource: UIResourceContent = {
    uri: "ui://test",
    mimeType: "application/vnd.mcp-ui.remote-dom+javascript; framework=react",
    text: "<div></div>",
  };

  beforeEach(() => {
    // Reset modules before each test to ensure isolation,
    // preventing state leakage from the component's module-level cache.
    vi.resetModules();
  });

  it("should render the loading state initially", async () => {
    const { McpUIResourceRenderer } = await import(
      "./mcp-ui-resource-renderer"
    );
    // Mock is not resolved, so it should stay in loading state
    render(<McpUIResourceRenderer resource={resource} />);
    expect(await screen.findByTestId("loading-skeleton")).toBeInTheDocument();
  });

  it("should render the UIResourceRenderer on successful load", async () => {
    const MockUIResourceRenderer = vi.fn(() => <div>Component Loaded</div>);
    vi.doMock("@mcp-ui/client", () => ({
      UIResourceRenderer: MockUIResourceRenderer,
    }));
    const { McpUIResourceRenderer } = await import(
      "./mcp-ui-resource-renderer"
    );

    render(<McpUIResourceRenderer resource={resource} />);
    await waitFor(() => {
      expect(MockUIResourceRenderer).toHaveBeenCalled();
      expect(screen.getByText("Component Loaded")).toBeInTheDocument();
    });
  });

  const setupMockedRenderer = async (
    renderer: (props: {
      onUIAction?: (action: UIActionResult) => void;
    }) => JSX.Element,
  ) => {
    vi.doMock("@mcp-ui/client", () => ({
      UIResourceRenderer: vi.fn(renderer),
    }));
    const { McpUIResourceRenderer } = await import(
      "./mcp-ui-resource-renderer"
    );
    return McpUIResourceRenderer;
  };

  it("should handle 'tool' UI action", async () => {
    const onToolCall = vi.fn();
    const McpUIResourceRenderer = await setupMockedRenderer(
      ({ onUIAction }) => (
        <button
          type="button"
          onClick={() =>
            onUIAction?.({
              type: "tool",
              payload: { toolName: "test-tool", params: { foo: "bar" } },
            })
          }
        >
          Tool Call
        </button>
      ),
    );

    render(
      <McpUIResourceRenderer resource={resource} onToolCall={onToolCall} />,
    );
    await waitFor(() => fireEvent.click(screen.getByText("Tool Call")));
    expect(onToolCall).toHaveBeenCalledWith("test-tool", { foo: "bar" });
  });

  it("should handle 'prompt' UI action", async () => {
    const onPromptSubmit = vi.fn();
    const McpUIResourceRenderer = await setupMockedRenderer(
      ({ onUIAction }) => (
        <button
          type="button"
          onClick={() =>
            onUIAction?.({ type: "prompt", payload: { prompt: "test prompt" } })
          }
        >
          Prompt
        </button>
      ),
    );

    render(
      <McpUIResourceRenderer
        resource={resource}
        onPromptSubmit={onPromptSubmit}
      />,
    );
    await waitFor(() => fireEvent.click(screen.getByText("Prompt")));
    expect(onPromptSubmit).toHaveBeenCalledWith("test prompt");
  });

  it("should handle 'intent' UI action", async () => {
    const onIntent = vi.fn();
    const McpUIResourceRenderer = await setupMockedRenderer(
      ({ onUIAction }) => (
        <button
          type="button"
          onClick={() =>
            onUIAction?.({
              type: "intent",
              payload: { intent: "test-intent", params: { baz: "qux" } },
            })
          }
        >
          Intent
        </button>
      ),
    );

    render(<McpUIResourceRenderer resource={resource} onIntent={onIntent} />);
    await waitFor(() => fireEvent.click(screen.getByText("Intent")));
    expect(onIntent).toHaveBeenCalledWith("test-intent", { baz: "qux" });
  });

  it("should handle 'link' UI action", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const McpUIResourceRenderer = await setupMockedRenderer(
      ({ onUIAction }) => (
        <button
          type="button"
          onClick={() =>
            onUIAction?.({
              type: "link",
              payload: { url: "https://example.com" },
            })
          }
        >
          Link
        </button>
      ),
    );

    render(<McpUIResourceRenderer resource={resource} />);
    await waitFor(() => fireEvent.click(screen.getByText("Link")));
    expect(open).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("should handle 'notify' UI action", async () => {
    const { toast } = await import("sonner");
    const McpUIResourceRenderer = await setupMockedRenderer(
      ({ onUIAction }) => (
        <button
          type="button"
          onClick={() =>
            onUIAction?.({
              type: "notify",
              payload: { message: "test notification" },
            })
          }
        >
          Notify
        </button>
      ),
    );

    render(<McpUIResourceRenderer resource={resource} />);
    await waitFor(() => fireEvent.click(screen.getByText("Notify")));
    expect(toast.info).toHaveBeenCalledWith("test notification");
  });
});
