import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrowserPanel, isBrowserToolOutput } from "./browser-panel";

describe("BrowserPanel", () => {
  describe("rendering", () => {
    it("should render nothing when no content is provided", () => {
      const { container } = render(<BrowserPanel />);
      expect(container.firstChild).toBeNull();
    });

    it("should render nothing when content is empty array", () => {
      const { container } = render(<BrowserPanel content={[]} />);
      expect(container.firstChild).toBeNull();
    });

    it("should render text content", () => {
      const content = [{ type: "text" as const, text: "Navigated to example.com" }];
      render(<BrowserPanel content={content} />);
      expect(screen.getByText("Navigated to example.com")).toBeInTheDocument();
    });

    it("should render URL in the URL bar", () => {
      const content = [{ type: "text" as const, text: "Page loaded" }];
      render(<BrowserPanel content={content} currentUrl="https://example.com" />);
      expect(screen.getByText("https://example.com")).toBeInTheDocument();
    });

    it("should show about:blank when no URL is provided", () => {
      const content = [{ type: "text" as const, text: "Some text" }];
      render(<BrowserPanel content={content} />);
      expect(screen.getByText("about:blank")).toBeInTheDocument();
    });

    it("should render page title in footer when provided", () => {
      const content = [{ type: "text" as const, text: "Content" }];
      render(
        <BrowserPanel
          content={content}
          currentUrl="https://example.com"
          pageTitle="Example Page Title"
        />,
      );
      expect(screen.getByText("Example Page Title")).toBeInTheDocument();
    });

    it("should not render page title footer when title equals URL", () => {
      const content = [{ type: "text" as const, text: "Content" }];
      render(
        <BrowserPanel
          content={content}
          currentUrl="https://example.com"
          pageTitle="https://example.com"
        />,
      );
      // Title should appear in URL bar but not as separate footer
      const urlElements = screen.getAllByText("https://example.com");
      expect(urlElements.length).toBe(1); // Only in URL bar
    });

    it("should show loading indicator when isLoading is true", () => {
      const content = [{ type: "text" as const, text: "Content" }];
      render(<BrowserPanel content={content} isLoading={true} />);
      // The Loader2Icon should be present (it has animate-spin class)
      const loadingElement = document.querySelector(".animate-spin");
      expect(loadingElement).toBeInTheDocument();
    });

    it("should render screenshot image when image content is provided", () => {
      const content = [
        {
          type: "image" as const,
          data: "iVBORw0KGgo=", // minimal base64
          mimeType: "image/png",
        },
      ];
      render(<BrowserPanel content={content} pageTitle="Screenshot test" />);
      const img = screen.getByAltText("Screenshot test");
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("src", expect.stringContaining("data:image/png;base64"));
    });

    it("should render fullscreen button for screenshots", () => {
      const content = [
        {
          type: "image" as const,
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
        },
      ];
      render(<BrowserPanel content={content} />);
      // Should have a button for fullscreen
      const button = document.querySelector('button[class*="size-7"]');
      expect(button).toBeInTheDocument();
    });

    it("should extract URL from text content", () => {
      const content = [
        { type: "text" as const, text: "Navigated to: https://example.com/page" },
      ];
      render(<BrowserPanel content={content} />);
      expect(screen.getByText("https://example.com/page")).toBeInTheDocument();
    });
  });

  describe("browser chrome", () => {
    it("should render window control dots", () => {
      const content = [{ type: "text" as const, text: "Content" }];
      render(<BrowserPanel content={content} />);
      // Check for the colored dots (red, yellow, green)
      const redDot = document.querySelector(".bg-red-400");
      const yellowDot = document.querySelector(".bg-yellow-400");
      const greenDot = document.querySelector(".bg-green-400");
      expect(redDot).toBeInTheDocument();
      expect(yellowDot).toBeInTheDocument();
      expect(greenDot).toBeInTheDocument();
    });

    it("should render external link for valid URLs", () => {
      const content = [{ type: "text" as const, text: "Content" }];
      render(<BrowserPanel content={content} currentUrl="https://example.com" />);
      const externalLink = document.querySelector('a[target="_blank"]');
      expect(externalLink).toBeInTheDocument();
      expect(externalLink).toHaveAttribute("href", "https://example.com");
    });
  });
});

describe("isBrowserToolOutput", () => {
  describe("tool name detection", () => {
    it("should return true for browser_ prefixed tools", () => {
      const output = [{ type: "text", text: "content" }];
      expect(isBrowserToolOutput("browser_navigate", output)).toBe(true);
      expect(isBrowserToolOutput("browser_screenshot", output)).toBe(true);
      expect(isBrowserToolOutput("browser_click", output)).toBe(true);
    });

    it("should return true for playwright tools", () => {
      const output = [{ type: "text", text: "content" }];
      expect(isBrowserToolOutput("playwright_action", output)).toBe(true);
    });

    it("should return true for navigate tools", () => {
      const output = [{ type: "text", text: "content" }];
      expect(isBrowserToolOutput("navigate", output)).toBe(true);
    });

    it("should return true for screenshot tools", () => {
      const output = [{ type: "text", text: "content" }];
      expect(isBrowserToolOutput("screenshot", output)).toBe(true);
    });

    it("should return false for non-browser tools", () => {
      const output = [{ type: "text", text: "content" }];
      expect(isBrowserToolOutput("file_read", output)).toBe(false);
      expect(isBrowserToolOutput("http_request", output)).toBe(false);
      expect(isBrowserToolOutput("database_query", output)).toBe(false);
    });
  });

  describe("output structure detection", () => {
    it("should return false for null output", () => {
      expect(isBrowserToolOutput("browser_navigate", null)).toBe(false);
    });

    it("should return false for undefined output", () => {
      expect(isBrowserToolOutput("browser_navigate", undefined)).toBe(false);
    });

    it("should return false for string output", () => {
      expect(isBrowserToolOutput("browser_navigate", "plain string")).toBe(false);
    });

    it("should return true for array with text type", () => {
      const output = [{ type: "text", text: "Navigated to URL" }];
      expect(isBrowserToolOutput("browser_navigate", output)).toBe(true);
    });

    it("should return true for array with image type", () => {
      const output = [{ type: "image", data: "base64", mimeType: "image/png" }];
      expect(isBrowserToolOutput("browser_screenshot", output)).toBe(true);
    });

    it("should return true for object with content property", () => {
      const output = {
        content: [{ type: "text", text: "content" }],
      };
      expect(isBrowserToolOutput("browser_navigate", output)).toBe(true);
    });

    it("should return false for empty array", () => {
      expect(isBrowserToolOutput("browser_navigate", [])).toBe(false);
    });

    it("should return false for array with invalid items", () => {
      const output = [{ foo: "bar" }, { baz: 123 }];
      expect(isBrowserToolOutput("browser_navigate", output)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle mixed content types", () => {
      const output = [
        { type: "text", text: "Navigated to page" },
        { type: "image", data: "base64", mimeType: "image/png" },
      ];
      expect(isBrowserToolOutput("browser_snapshot", output)).toBe(true);
    });

    it("should handle browserNavigate camelCase naming", () => {
      const output = [{ type: "text", text: "content" }];
      expect(isBrowserToolOutput("browserNavigate", output)).toBe(true);
    });

    it("should handle Browser prefix with uppercase", () => {
      const output = [{ type: "text", text: "content" }];
      expect(isBrowserToolOutput("Browser", output)).toBe(true);
    });
  });
});
