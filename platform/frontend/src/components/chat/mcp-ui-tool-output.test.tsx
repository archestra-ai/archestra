import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// next-runtime-env tries to read runtime-injected env vars.
// For unit tests, just map to process.env.
vi.mock("next-runtime-env", () => ({
  env: vi.fn((key: string) => process.env[key]),
}));

const mockState = vi.hoisted(() => ({
  lastAppRendererProps: null as null | Record<string, unknown>,
  lastUiResourceRendererProps: null as null | Record<string, unknown>,
  sendMessage: vi.fn(),
}));

vi.mock("@/contexts/global-chat-context", () => ({
  useChatSession: () => ({
    sendMessage: mockState.sendMessage,
  }),
}));

vi.mock("@/lib/mcp-ui.query", () => ({
  callMcpUiTool: vi.fn(async () => ({ content: [], isError: false })),
  readMcpUiResource: vi.fn(async () => ({ contents: [] })),
}));

vi.mock("@mcp-ui/client", () => ({
  AppRenderer: (props: Record<string, unknown>) => {
    mockState.lastAppRendererProps = props;
    return <div data-testid="mcp-app-renderer" />;
  },
  UIResourceRenderer: (props: Record<string, unknown>) => {
    mockState.lastUiResourceRendererProps = props;
    return <div data-testid="mcp-ui-resource-renderer" />;
  },
}));

import { McpUiToolOutput } from "./mcp-ui-tool-output";

describe("McpUiToolOutput", () => {
  beforeEach(() => {
    mockState.lastAppRendererProps = null;
    mockState.lastUiResourceRendererProps = null;
    vi.clearAllMocks();
  });

  it("returns null when there are no UI/image blocks and no toolResourceUri", () => {
    const { container } = render(
      <McpUiToolOutput
        agentId="agent-123"
        conversationId="conv-1"
        toolName="some_tool"
        toolInput={undefined}
        toolOutput={[{ type: "text", text: "hello" }]}
        toolResourceUri={undefined}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders legacy UIResourceRenderer for MCP resource blocks and sets proxy URL", () => {
    render(
      <McpUiToolOutput
        agentId="agent-123"
        conversationId="conv-1"
        toolName="some_tool"
        toolInput={{}}
        toolOutput={[
          {
            type: "resource",
            resource: {
              uri: "mcp://ui/resource-1",
            },
          },
        ]}
        toolResourceUri={undefined}
      />,
    );

    expect(screen.getByTestId("mcp-ui-resource-renderer")).toBeInTheDocument();

    const props = mockState.lastUiResourceRendererProps as any;
    expect(props.resource.uri).toBe("mcp://ui/resource-1");
    expect(props.htmlProps.proxy).toBe("http://localhost:9000/mcp-ui-proxy");
  });

  it("renders AppRenderer when toolResourceUri is provided and sets sandbox URL", () => {
    render(
      <McpUiToolOutput
        agentId="agent-123"
        conversationId="conv-1"
        toolName="some_tool"
        toolInput={{ foo: "bar" }}
        toolOutput={[{ type: "text", text: "ok" }]}
        toolResourceUri="mcp://tool/ui"
      />,
    );

    expect(screen.getByTestId("mcp-app-renderer")).toBeInTheDocument();

    const props = mockState.lastAppRendererProps as any;
    expect(props.toolName).toBe("some_tool");
    expect(props.toolResourceUri).toBe("mcp://tool/ui");
    expect(props.sandbox.url.toString()).toBe(
      "http://localhost:9000/sandbox_proxy.html",
    );
  });
});
