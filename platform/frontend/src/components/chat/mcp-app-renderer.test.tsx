import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

// Mock next-themes
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

// Import after mocks
import { McpAppRenderer } from "./mcp-app-renderer";

describe("McpAppRenderer", () => {
  test("renders iframe with sandbox attributes", () => {
    const { container } = render(
      <McpAppRenderer htmlContent="<div>Hello MCP App</div>" />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe?.getAttribute("title")).toBe("MCP App");
  });

  test("renders with border when prefersBorder is true", () => {
    const { container } = render(
      <McpAppRenderer
        htmlContent="<div>Test</div>"
        prefersBorder={true}
      />,
    );

    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("border");
  });

  test("renders without border when prefersBorder is false", () => {
    const { container } = render(
      <McpAppRenderer
        htmlContent="<div>Test</div>"
        prefersBorder={false}
      />,
    );

    const wrapper = container.firstElementChild;
    expect(wrapper?.className).not.toContain("border-border");
  });
});
