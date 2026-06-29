import { describe, expect, test } from "@/test";
import { stripBrowserToolsResults } from "./summarize-tool-results";

describe("stripBrowserToolsResults", () => {
  test("strips older browser_navigate results but preserves the most recent", () => {
    const largeYamlContent = `### Ran Playwright code
await page.goto('https://archestra.ai');

### Open tabs
- 0: [] (about:blank)
- 1: (current) [Archestra | Enterprise MCP Platform] (https://archestra.ai/)

### Page state
- Page URL: https://archestra.ai/
- Page Title: Archestra | Enterprise MCP Platform
- Page Snapshot:
\`\`\`yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - generic [ref=e4]:
        - link "Archestra Logo" [ref=e6]:
          - /url: /
          - img "Archestra Logo" [ref=e7]
    - main [ref=e20]:
      - heading "Central Place for AI" [level=1] [ref=e24]
      - paragraph [ref=e25]: Open Source
${"      - generic [ref=e100]: ".repeat(100)}
\`\`\`
`;
    const newerYamlContent = `${largeYamlContent}\n${"x".repeat(3000)}`;

    const messages = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_123",
            type: "function" as const,
            function: {
              arguments: '{"url":"https://archestra.ai"}',
              name: "microsoft__playwright-mcp__browser_navigate",
            },
          },
        ],
      },
      {
        role: "tool" as const,
        content: largeYamlContent,
        tool_call_id: "call_123",
      },
      {
        role: "assistant" as const,
        content: "Navigation complete",
      },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_456",
            type: "function" as const,
            function: {
              arguments: '{"url":"https://archestra.ai"}',
              name: "microsoft__playwright-mcp__browser_navigate",
            },
          },
        ],
      },
      {
        role: "tool" as const,
        content: newerYamlContent,
        tool_call_id: "call_456",
      },
    ];

    const result = stripBrowserToolsResults(messages);

    // Older tool result should be stripped
    expect(result[1].role).toBe("tool");
    expect(result[1].tool_call_id).toBe("call_123");
    expect(result[1].content).toContain("[Page");
    expect(result[1].content).toContain("browser_navigate was here]");
    expect((result[1].content as string).length).toBeLessThan(200);

    // Most recent tool result should be preserved
    expect(result[4].role).toBe("tool");
    expect(result[4].tool_call_id).toBe("call_456");
    expect(result[4].content).toBe(newerYamlContent);
  });

  test("strips older browser_snapshot results but preserves the most recent", () => {
    const largeSnapshot = `### Open tabs\n${"x".repeat(5000)}`;
    const newerSnapshot = `### Open tabs\n${"y".repeat(6000)}`;

    const messages = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_456",
            type: "function" as const,
            function: {
              arguments: "{}",
              name: "microsoft__playwright-mcp__browser_snapshot",
            },
          },
        ],
      },
      {
        role: "tool" as const,
        content: largeSnapshot,
        tool_call_id: "call_456",
      },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_789",
            type: "function" as const,
            function: {
              arguments: "{}",
              name: "microsoft__playwright-mcp__browser_snapshot",
            },
          },
        ],
      },
      {
        role: "tool" as const,
        content: newerSnapshot,
        tool_call_id: "call_789",
      },
    ];

    const result = stripBrowserToolsResults(messages);

    expect(result[1].content).toContain("[Page");
    expect(result[1].content).toContain("browser_snapshot was here]");
    expect(result[3].content).toBe(newerSnapshot);
  });

  test("does not strip small tool results", () => {
    const smallContent = "Navigation successful";

    const messages = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_789",
            type: "function" as const,
            function: {
              arguments: '{"url":"https://example.com"}',
              name: "microsoft__playwright-mcp__browser_navigate",
            },
          },
        ],
      },
      {
        role: "tool" as const,
        content: smallContent,
        tool_call_id: "call_789",
      },
    ];

    const result = stripBrowserToolsResults(messages);

    // Small result should not be stripped
    expect(result[1].content).toBe(smallContent);
  });

  test("does not strip non-browser tool results", () => {
    const largeContent = "x".repeat(5000);

    const messages = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_other",
            type: "function" as const,
            function: {
              arguments: "{}",
              name: "some_other_tool",
            },
          },
        ],
      },
      {
        role: "tool" as const,
        content: largeContent,
        tool_call_id: "call_other",
      },
    ];

    const result = stripBrowserToolsResults(messages);

    // Non-browser tool should not be stripped even if large
    expect(result[1].content).toBe(largeContent);
  });

  test("extracts URL from content for placeholder", () => {
    const contentWithUrl = `### Page state
- Page URL: https://example.com/test
- Page Title: Test Page
${"x".repeat(3000)}`;
    const newerContent = "Navigation successful";

    const messages = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_url",
            type: "function" as const,
            function: {
              arguments: "{}",
              name: "browser_navigate",
            },
          },
        ],
      },
      {
        role: "tool" as const,
        content: contentWithUrl,
        tool_call_id: "call_url",
      },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_new",
            type: "function" as const,
            function: {
              arguments: "{}",
              name: "browser_navigate",
            },
          },
        ],
      },
      {
        role: "tool" as const,
        content: newerContent,
        tool_call_id: "call_new",
      },
    ];

    const result = stripBrowserToolsResults(messages);

    expect(result[1].content).toContain("https://example.com/test");
  });

  test("handles messages without tool_calls array", () => {
    const messages = [
      {
        content: "Hello",
        role: "user" as const,
      },
      {
        role: "assistant" as const,
        content: "Hi there!",
      },
    ];

    const result = stripBrowserToolsResults(messages);

    expect(result).toEqual(messages);
  });
});
