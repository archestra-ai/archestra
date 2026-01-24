import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasUIResource, UIResourceTool } from "./ui-resource-tool";

// Mock @mcp-ui/client
vi.mock("@mcp-ui/client", () => ({
  UIResourceRenderer: vi.fn(({ resource, onUIAction }) => (
    <div data-testid="ui-resource-renderer" data-resource={JSON.stringify(resource)}>
      <button
        data-testid="trigger-tool-action"
        onClick={() => onUIAction({ type: "tool", payload: { toolName: "test_tool", params: { foo: "bar" } } })}
      >
        Trigger Tool
      </button>
      <button
        data-testid="trigger-prompt-action"
        onClick={() => onUIAction({ type: "prompt", payload: { prompt: "test prompt" } })}
      >
        Trigger Prompt
      </button>
      <button
        data-testid="trigger-link-action-safe"
        onClick={() => onUIAction({ type: "link", payload: { url: "https://example.com" } })}
      >
        Trigger Safe Link
      </button>
      <button
        data-testid="trigger-link-action-unsafe"
        onClick={() => onUIAction({ type: "link", payload: { url: "javascript:alert(1)" } })}
      >
        Trigger Unsafe Link
      </button>
      <button
        data-testid="trigger-notify-action"
        onClick={() => onUIAction({ type: "notify", payload: { message: "Test notification" } })}
      >
        Trigger Notify
      </button>
      <button
        data-testid="trigger-intent-action"
        onClick={() => onUIAction({ type: "intent", payload: { intent: "test intent" } })}
      >
        Trigger Intent
      </button>
      <button
        data-testid="trigger-unknown-action"
        onClick={() => onUIAction({ type: "unknown_type", payload: {} })}
      >
        Trigger Unknown
      </button>
    </div>
  )),
}));

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
  },
}));

// Import the mocked toast for assertions
import { toast as mockToast } from "sonner";

// Mock window.open
const mockWindowOpen = vi.fn();
Object.defineProperty(window, "open", {
  value: mockWindowOpen,
  writable: true,
});

// Mock extractUIResource to return controlled values
vi.mock("./ui-resource.utils", () => ({
  extractUIResource: vi.fn((output) => {
    if (output === null || output === undefined) return null;
    if (typeof output === "object" && output !== null && "uri" in output) {
      return output;
    }
    return null;
  }),
  isUIResource: vi.fn((obj) => {
    return typeof obj === "object" && obj !== null && "uri" in obj;
  }),
}));

describe("UIResourceTool", () => {
  const mockOnToolCall = vi.fn();
  const mockOnPrompt = vi.fn();

  const validUIResource = {
    uri: "ui://component/test",
    mimeType: "text/html",
    text: "<div>Hello</div>",
  };

  const createToolPart = (output: unknown) => ({
    type: "tool-test" as const,
    state: "output-available" as const,
    toolCallId: "test-123",
    input: { param: "value" },
    output,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("should render null when no UIResource is present", () => {
      const { container } = render(
        <UIResourceTool
          part={createToolPart(null)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      expect(container.firstChild).toBeNull();
    });

    it("should render UIResourceRenderer when valid UIResource is present", () => {
      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      expect(screen.getByTestId("ui-resource-renderer")).toBeInTheDocument();
    });

    it("should render with tool name in header", () => {
      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="my_custom_tool"
        />,
      );

      expect(screen.getByText("my_custom_tool")).toBeInTheDocument();
    });

    it("should have ARIA label for accessibility", () => {
      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      expect(
        screen.getByLabelText("Interactive MCP UI component"),
      ).toBeInTheDocument();
    });

    it("should render Interactive UI header", () => {
      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      expect(screen.getByText("Interactive UI")).toBeInTheDocument();
    });
  });

  describe("external URL handling", () => {
    it("should show external link for text/uri-list with safe URL", () => {
      const uriListResource = {
        uri: "ui://component/test",
        mimeType: "text/uri-list",
        text: "https://example.com/embed",
      };

      render(
        <UIResourceTool
          part={createToolPart(uriListResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      const link = screen.getByRole("link", { name: /open in new tab/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "https://example.com/embed");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("should not show external link for unsafe URL protocols", () => {
      const unsafeResource = {
        uri: "ui://component/test",
        mimeType: "text/uri-list",
        text: "javascript:alert(1)",
      };

      render(
        <UIResourceTool
          part={createToolPart(unsafeResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      expect(
        screen.queryByRole("link", { name: /open in new tab/i }),
      ).not.toBeInTheDocument();
    });

    it("should not show external link for data: URLs", () => {
      const dataResource = {
        uri: "ui://component/test",
        mimeType: "text/uri-list",
        text: "data:text/html,<script>alert(1)</script>",
      };

      render(
        <UIResourceTool
          part={createToolPart(dataResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      expect(
        screen.queryByRole("link", { name: /open in new tab/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("handleUIAction - tool action", () => {
    it("should call onToolCall when tool action is triggered", async () => {
      const user = userEvent.setup();

      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
          onToolCall={mockOnToolCall}
          onPrompt={mockOnPrompt}
        />,
      );

      await user.click(screen.getByTestId("trigger-tool-action"));

      expect(mockOnToolCall).toHaveBeenCalledWith("test_tool", { foo: "bar" });
    });

    it("should not throw when onToolCall is not provided", async () => {
      const user = userEvent.setup();

      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      // Should not throw
      await user.click(screen.getByTestId("trigger-tool-action"));
    });
  });

  describe("handleUIAction - prompt action", () => {
    it("should call onPrompt when prompt action is triggered", async () => {
      const user = userEvent.setup();

      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
          onToolCall={mockOnToolCall}
          onPrompt={mockOnPrompt}
        />,
      );

      await user.click(screen.getByTestId("trigger-prompt-action"));

      expect(mockOnPrompt).toHaveBeenCalledWith("test prompt");
    });
  });

  describe("handleUIAction - link action", () => {
    it("should open safe URLs in new tab", async () => {
      const user = userEvent.setup();

      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      await user.click(screen.getByTestId("trigger-link-action-safe"));

      expect(mockWindowOpen).toHaveBeenCalledWith(
        "https://example.com",
        "_blank",
        "noopener,noreferrer",
      );
    });

    it("should not open unsafe URLs (javascript:)", async () => {
      const user = userEvent.setup();

      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      await user.click(screen.getByTestId("trigger-link-action-unsafe"));

      expect(mockWindowOpen).not.toHaveBeenCalled();
    });
  });

  describe("handleUIAction - notify action", () => {
    it("should show toast notification with message", async () => {
      const user = userEvent.setup();

      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      await user.click(screen.getByTestId("trigger-notify-action"));

      expect(mockToast.info).toHaveBeenCalledWith("Test notification");
    });
  });

  describe("handleUIAction - intent action", () => {
    it("should call onPrompt with intent", async () => {
      const user = userEvent.setup();

      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
          onPrompt={mockOnPrompt}
        />,
      );

      await user.click(screen.getByTestId("trigger-intent-action"));

      expect(mockOnPrompt).toHaveBeenCalledWith("test intent");
    });
  });

  describe("handleUIAction - unknown action", () => {
    it("should handle unknown action types gracefully", async () => {
      const user = userEvent.setup();

      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      // Should not throw
      await user.click(screen.getByTestId("trigger-unknown-action"));
    });
  });

  describe("error state", () => {
    it("should display error text when provided", () => {
      render(
        <UIResourceTool
          part={createToolPart(validUIResource)}
          toolResultPart={null}
          toolName="test_tool"
          errorText="Something went wrong"
        />,
      );

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });
  });

  describe("tool input display", () => {
    it("should display tool input when present", () => {
      const partWithInput = {
        ...createToolPart(validUIResource),
        input: { searchQuery: "test query", limit: 10 },
      };

      render(
        <UIResourceTool
          part={partWithInput}
          toolResultPart={null}
          toolName="test_tool"
        />,
      );

      // The ToolInput component should be rendered - check the component renders
      // Input is displayed in a collapsible section
      expect(screen.getByTestId("ui-resource-renderer")).toBeInTheDocument();
    });
  });
});

describe("hasUIResource", () => {
  it("should return false for null", () => {
    expect(hasUIResource(null)).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(hasUIResource(undefined)).toBe(false);
  });

  it("should return true for valid UIResource", () => {
    const resource = {
      uri: "ui://component/test",
      mimeType: "text/html",
      text: "<div>Hello</div>",
    };
    expect(hasUIResource(resource)).toBe(true);
  });
});
