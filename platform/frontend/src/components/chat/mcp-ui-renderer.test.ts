import { describe, it, expect } from "vitest";
import { detectMCPUIResource, detectMCPApp } from "./mcp-ui-renderer";

describe("detectMCPUIResource", () => {
  it("detects text/uri-list resource from MCP UI demo server", () => {
    // Response from show_task_status tool
    const toolOutput = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "ui://task-manager/1770481222924",
            mimeType: "text/uri-list",
            text: "https://remote-mcp-server-authless.idosalomon.workers.dev/task",
          },
        },
      ],
    };

    const result = detectMCPUIResource(toolOutput);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("text/uri-list");
    expect(result?.uri).toBe("ui://task-manager/1770481222924");
    expect(result?.text).toBe(
      "https://remote-mcp-server-authless.idosalomon.workers.dev/task"
    );
  });

  it("detects remote-dom resource from MCP UI demo server", () => {
    // Response from show_remote_dom_react tool
    const toolOutput = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "ui://remote-dom-react/1770481240583",
            mimeType:
              "application/vnd.mcp-ui.remote-dom+javascript; framework=react",
            text: `
            const stack = document.createElement('ui-stack');
            stack.setAttribute('direction', 'vertical');
            root.appendChild(stack);
          `,
          },
        },
      ],
    };

    const result = detectMCPUIResource(toolOutput);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe(
      "application/vnd.mcp-ui.remote-dom+javascript; framework=react"
    );
    expect(result?.uri).toBe("ui://remote-dom-react/1770481240583");
  });

  it("detects text/html resource", () => {
    const toolOutput = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "ui://greeting/1",
            mimeType: "text/html",
            text: "<p>Hello, MCP UI!</p>",
          },
        },
      ],
    };

    const result = detectMCPUIResource(toolOutput);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("text/html");
    expect(result?.text).toBe("<p>Hello, MCP UI!</p>");
  });

  it("detects direct resource object", () => {
    const toolOutput = {
      uri: "ui://test/1",
      mimeType: "text/html",
      text: "<div>Test</div>",
    };

    const result = detectMCPUIResource(toolOutput);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("text/html");
  });

  it("detects nested resource object", () => {
    const toolOutput = {
      resource: {
        uri: "ui://test/1",
        mimeType: "text/html",
        text: "<div>Test</div>",
      },
    };

    const result = detectMCPUIResource(toolOutput);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("text/html");
  });

  it("returns null for non-UI resource", () => {
    const toolOutput = {
      content: [
        {
          type: "text",
          text: "Regular text response",
        },
      ],
    };

    const result = detectMCPUIResource(toolOutput);
    expect(result).toBeNull();
  });

  it("returns null for unsupported mimeType", () => {
    const toolOutput = {
      uri: "ui://test/1",
      mimeType: "application/json",
      text: "{}",
    };

    const result = detectMCPUIResource(toolOutput);
    expect(result).toBeNull();
  });

  it("returns null for null input", () => {
    expect(detectMCPUIResource(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(detectMCPUIResource(undefined)).toBeNull();
  });
});

describe("detectMCPApp", () => {
  it("detects MCP App with _meta.ui.resourceUri", () => {
    const toolDefinition = {
      name: "interactive_chart",
      description: "Shows an interactive chart",
      _meta: {
        ui: {
          resourceUri: "ui://charts/interactive",
        },
      },
    };

    const result = detectMCPApp(toolDefinition);
    expect(result).not.toBeNull();
    expect(result?.toolName).toBe("interactive_chart");
    expect(result?.resourceUri).toBe("ui://charts/interactive");
  });

  it("returns null for tool without _meta", () => {
    const toolDefinition = {
      name: "regular_tool",
      description: "A regular tool",
    };

    const result = detectMCPApp(toolDefinition);
    expect(result).toBeNull();
  });

  it("returns null for tool without ui in _meta", () => {
    const toolDefinition = {
      name: "tool_with_meta",
      _meta: {
        other: "value",
      },
    };

    const result = detectMCPApp(toolDefinition);
    expect(result).toBeNull();
  });

  it("returns null for null input", () => {
    expect(detectMCPApp(null)).toBeNull();
  });
});
