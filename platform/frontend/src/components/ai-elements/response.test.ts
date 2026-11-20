import { render } from "@testing-library/react";
import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { isSameOriginUrl, preloadResponseMarkdown, Response } from "./response";

// The renderer is a lazy chunk; once loaded it renders in the same pass.
beforeAll(() => preloadResponseMarkdown());

const APP_ID = "7b0839a1-4663-4371-a739-e5dac7f8c33e";

// linkSafety off makes Streamdown render a real <a href> we can read, instead of
// the safe-link <button> whose target lives in an onClick closure.
function renderResponse(markdown: string) {
  return render(
    createElement(Response, { linkSafety: { enabled: false } }, markdown),
  );
}

describe("isSameOriginUrl", () => {
  // jsdom sets window.location.origin to "http://localhost:3000" by default in vitest

  it("returns true for same-origin absolute URL", () => {
    expect(isSameOriginUrl("http://localhost:3000/mcp/registry")).toBe(true);
  });

  it("returns true for same-origin URL with query params", () => {
    expect(
      isSameOriginUrl("http://localhost:3000/mcp/registry?install=cat_abc123"),
    ).toBe(true);
  });

  it("returns true for same-origin URL with hash", () => {
    expect(isSameOriginUrl("http://localhost:3000/settings#tab")).toBe(true);
  });

  it("returns true for relative path (resolved against current origin)", () => {
    expect(isSameOriginUrl("/mcp/registry?install=cat_abc")).toBe(true);
  });

  it("returns false for different host", () => {
    expect(isSameOriginUrl("https://evil.com/phishing")).toBe(false);
  });

  it("returns false for different port", () => {
    expect(isSameOriginUrl("http://localhost:9000/api/config")).toBe(false);
  });

  it("returns false for different protocol (http vs https)", () => {
    expect(isSameOriginUrl("https://localhost:3000/mcp/registry")).toBe(false);
  });

  it("returns true for relative-looking strings (resolved against current origin)", () => {
    // "not a url at all" gets resolved as a relative path by the URL constructor
    expect(isSameOriginUrl("not a url at all")).toBe(true);
  });

  it("returns false for javascript: protocol", () => {
    expect(isSameOriginUrl("javascript:alert(1)")).toBe(false);
  });

  it("returns false for data: URI", () => {
    expect(isSameOriginUrl("data:text/html,<h1>hi</h1>")).toBe(false);
  });
});

const TABLE_MARKDOWN = "| a | b |\n| --- | --- |\n| 1 | 2 |";

describe("Response markdown tables", () => {
  // Streamdown paints table-wrapper with an opaque bg-sidebar mat that clashes
  // with themed chat bubbles (bg-secondary), and ignores its className prop, so
  // Response must flatten it via descendant overrides on the root. Guards both
  // sides of that contract: the override classes, and the data-streamdown
  // attribute + mat class they target (either can drift on a streamdown upgrade).
  it("flattens streamdown's opaque table-wrapper mat", () => {
    const { container } = renderResponse(TABLE_MARKDOWN);
    const wrapper = container.querySelector(
      '[data-streamdown="table-wrapper"]',
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain("bg-sidebar");

    const root = container.firstElementChild;
    expect(root?.className).toContain(
      "[&_[data-streamdown='table-wrapper']]:bg-transparent",
    );
    expect(root?.className).toContain(
      "[&_[data-streamdown='table-wrapper']]:border-0",
    );
    expect(root?.className).toContain(
      "[&_[data-streamdown='table-wrapper']]:p-0",
    );
    // The toolbar loses its mat backdrop, so its buttons must inherit the
    // bubble's paired text color to stay visible on bg-secondary.
    expect(root?.className).toContain(
      "[&_[data-streamdown='table-wrapper']_button]:text-inherit",
    );
    // Opaque bg-background surfaces inside the wrapper must re-pair with
    // text-foreground, not the bubble's inherited secondary-foreground.
    expect(root?.className).toContain(
      "[&_[data-streamdown='table-wrapper']_.bg-background]:text-foreground",
    );
  });

  it("keeps the table scroll cap and sticky header overrides", () => {
    const { container } = renderResponse(TABLE_MARKDOWN);
    expect(container.querySelector('[data-streamdown="table"]')).not.toBeNull();

    const root = container.firstElementChild;
    expect(root?.className).toContain(
      "[&_[data-streamdown='table-wrapper']>div:last-child]:max-h-[420px]",
    );
    expect(root?.className).toContain(
      "[&_[data-streamdown='table-header']]:sticky",
    );
  });
});

// Renders through the real Streamdown pipeline (including rehype-harden), so it
// verifies the repair runs before harden — harden would otherwise drop a
// slash-less relative link and it would never reach an <a href>.
describe("Response app-link canonicalization", () => {
  it("renders a slash-dropped app link as the absolute app path", () => {
    const { container } = renderResponse(`[Open](a/${APP_ID})`);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe(`/a/${APP_ID}`);
    expect(anchor?.textContent).toBe("Open");
  });

  it("leaves an already-absolute app link unchanged", () => {
    const { container } = renderResponse(`[Open](/a/${APP_ID})`);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `/a/${APP_ID}`,
    );
  });

  it("does not rewrite an external link", () => {
    const { container } = renderResponse(
      `[Site](https://example.com/a/${APP_ID})`,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `https://example.com/a/${APP_ID}`,
    );
  });

  it("repairs a slash-dropped custom-slug app link", () => {
    // An app addressed by its slug is the same link shape as one addressed by
    // its id, and the model drops the leading slash on both.
    const { container } = renderResponse("[Open](a/sales-dashboard)");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/a/sales-dashboard",
    );
  });

  it.each([
    ["uppercase, which no slug contains", "a/Sales-Dashboard"],
    ["an underscore", "a/sales_dashboard"],
    ["a trailing hyphen", "a/sales-"],
    ["a nested path segment", "a/sales/dashboard"],
  ])("does not repair a slashless a/ prefix with %s", (_label, url) => {
    // The repair keys on the id and slug shapes only, so anything that could
    // not be an app address is left alone. (harden then blocks the slashless
    // relative link, so no anchor survives — the point is only that our plugin
    // did not rewrite it.)
    const { container } = renderResponse(`[Docs](${url})`);
    expect(container.querySelector(`a[href="/${url}"]`)).toBeNull();
  });

  it("does not rewrite the pattern inside a code span", () => {
    const { container } = renderResponse(`\`a/${APP_ID}\``);
    expect(container.querySelector("code")?.textContent).toBe(`a/${APP_ID}`);
  });
});

// Through the real Streamdown pipeline: pins that the math plugin is wired up,
// that KaTeX output survives rehype-harden, and that the delimiter rewrite
// reaches it.
describe("Response math", () => {
  const formulas = (container: HTMLElement) =>
    container.querySelectorAll(".katex").length;
  const displayFormulas = (container: HTMLElement) =>
    container.querySelectorAll(".katex-display").length;

  it.each([
    [
      "\\[…\\]",
      "The roots are:\n\n\\[ x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a} \\]",
    ],
    ["$$…$$ on its own line", "The roots are:\n\n$$x = \\frac{-b}{2a}$$"],
    ["a $$ fenced block", "$$\nx^2 + y^2 = r^2\n$$"],
  ])("renders %s as a display formula", (_label, markdown) => {
    const { container } = renderResponse(markdown);
    expect(displayFormulas(container)).toBe(1);
    // No delimiter is left behind as text.
    expect(container.textContent).not.toMatch(/\\\[|\$\$/);
  });

  it.each([
    ["\\(…\\)", "where \\(a \\neq 0\\) holds"],
    ["$…$", "where $a \\neq 0$ holds"],
    ["$$…$$ inside a sentence", "where $$a \\neq 0$$ holds"],
  ])("renders %s inline", (_label, markdown) => {
    const { container } = renderResponse(markdown);
    expect(formulas(container)).toBe(1);
    expect(displayFormulas(container)).toBe(0);
    expect(container.querySelector("p")?.textContent).toMatch(
      /^where .+ holds$/,
    );
  });

  it("renders a model's quadratic-formula answer without stray TeX", () => {
    const answer = [
      "The quadratic formula solves $ax^2 + bx + c = 0$ for $x$, where $a \\neq 0$:",
      "",
      "$$",
      "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
      "$$",
      "",
      "- $a$, $b$, $c$ are the coefficients of the equation.",
      "- $\\pm$ gives two solutions, one with $+$ and one with $-$.",
      "- $b^2 - 4ac$ is the **discriminant**.",
      "",
      "**Example:** $2x^2 + 4x - 6 = 0$ gives $a = 2$, $b = 4$, $c = -6$:",
      "",
      "So $x = 1$ or $x = -3$.",
    ].join("\n");
    const { container } = renderResponse(answer);
    expect(displayFormulas(container)).toBe(1);
    // 16 inline formulas and the display one.
    expect(formulas(container)).toBe(17);
    for (const element of container.querySelectorAll(".katex-mathml")) {
      element.remove();
    }
    expect(container.textContent).not.toContain("$");
  });

  it("keeps a formula with | inside its table cell", () => {
    const { container } = renderResponse(
      [
        "| Condition | Roots |",
        "| :--- | :--- |",
        "| $\\Delta < 0$ | Complex ($x = \\frac{-b \\pm i\\sqrt{|\\Delta|}}{2a}$) |",
      ].join("\n"),
    );
    const cells = container.querySelectorAll("tbody td");
    expect(cells).toHaveLength(2);
    expect(cells[1].querySelectorAll(".katex")).toHaveLength(1);
    expect(cells[1].textContent).not.toContain("$");
  });

  it("keeps a display formula inside its list item", () => {
    const { container } = renderResponse(
      "1. Square it:\n\n   \\[ x^2 \\]\n\n2. Next step",
    );
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".katex-display")).not.toBeNull();
    expect(items[1].textContent?.trim()).toBe("Next step");
  });

  it.each([
    "Set $HOME and $PATH before running.",
    'Write "$HOME" and "$PATH"',
    "Use $HOME/$PATH here",
    "It costs $5 and $10 later",
    "Between $5-$10 per seat",
    "Plans run $5/$10 a month",
  ])("leaves %j as plain text", (markdown) => {
    const { container } = renderResponse(markdown);
    expect(formulas(container)).toBe(0);
    expect(container.textContent).toBe(markdown);
  });

  it("leaves TeX inside code alone", () => {
    const { container } = renderResponse(
      "Inline `$x$` and `\\(y\\)`.\n\n```tex\n\\[ z \\]\n$$w$$\n```",
    );
    expect(formulas(container)).toBe(0);
    expect(container.querySelector("p code")?.textContent).toBe("$x$");
  });
});
