import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { isSameOriginUrl, Response } from "./response";

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

// Renders through the real Streamdown pipeline, so this covers what the unit
// tests for the delimiter rewrite cannot: that the math plugin is wired up, its
// rehype stage survives rehype-harden, and display vs inline is preserved.
describe("Response math rendering", () => {
  it("renders bracket display math as a centered formula", () => {
    const { container } = renderResponse(
      "\\[ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\]",
    );
    expect(container.querySelector(".katex-display")).not.toBeNull();
    // The reported bug is delimiters shown verbatim; the TeX source itself
    // legitimately survives in KaTeX's MathML <annotation>, so assert on the
    // delimiters and on the visual layer rather than on the whole subtree.
    expect(container.textContent).not.toContain("\\[");
    expect(container.querySelector(".katex-html")?.textContent).not.toContain(
      "\\",
    );
  });

  it("renders bracket inline math inside the surrounding paragraph", () => {
    const { container } = renderResponse(
      "Pythagoras says \\(a^2 + b^2\\) holds",
    );
    const paragraph = container.querySelector("p");
    expect(paragraph?.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".katex-display")).toBeNull();
    expect(paragraph?.textContent).toContain("Pythagoras says");
  });

  it("renders dollar-delimited math that models already emit correctly", () => {
    const { container } = renderResponse("$$\nE = mc^2\n$$");
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  // Single-dollar math stays disabled precisely so prices survive untouched.
  it("leaves prices in prose alone", () => {
    const { container } = renderResponse(
      "The plan costs $5 and the add-on $10",
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5");
    expect(container.textContent).toContain("$10");
  });

  // The normalized string looks harmless in isolation; only a render shows the
  // damage. Display math indented inside a list item must not break out of the
  // item and swallow the following content into the math block.
  it("keeps a list intact around indented display math", () => {
    const { container } = renderResponse(
      "1. First:\n\n   \\[ x^2 \\]\n\n2. Second",
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.textContent).toContain("Second");
  });

  it("does not render math inside a code block", () => {
    const { container } = renderResponse("```\n\\[ x^2 \\]\n```");
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("\\[ x^2 \\]");
  });

  // Single-dollar math is the form models reach for most often, and it reaches
  // the renderer only because preprocess-latex.ts promotes it. These cases are
  // taken from real replies that showed raw TeX on screen.
  it("renders single-dollar math inside bold and heading text", () => {
    const { container } = renderResponse(
      "**Second Moment $E[X_i^2]$**: $$E[X_i^2] = p$$",
    );
    expect(container.querySelectorAll(".katex").length).toBe(2);
    expect(container.textContent).not.toContain("$E[X_i^2]$");
  });

  it("renders a single-dollar macro that KaTeX supports", () => {
    const { container } = renderResponse("The count is $\\binom{n}{k}$ ways.");
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("keeps a price and inline math apart on the same line", () => {
    const { container } = renderResponse("Costs $5, and $x^2$ is the formula");
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).toContain("$5");
  });

  // Dollar and bracket math in one reply: each pass has to leave the other's
  // work alone.
  it("renders dollar and bracket math in the same reply", () => {
    const { container } = renderResponse(
      "Let $q = 1 - p$, so \\[ \\text{Var}(X) = npq \\] follows.",
    );
    expect(container.querySelectorAll(".katex").length).toBe(2);
    expect(container.querySelector(".katex-error")).toBeNull();
  });
});

// Promoting `$…$` is the one rewrite that can turn ordinary prose into a
// formula, and the damage is invisible in the normalized string — only a render
// shows text being swallowed. These assert on the rendered output for that
// reason, and are kept as a corpus because the rule is a balance of several
// lookarounds: a change that fixes one shape tends to regress another.
describe("Response dollar-sign safety", () => {
  it.each([
    // prices
    "The plan costs $5 and the addon is $10.",
    "Revenue grew from $20,000 and $30,000 last year.",
    "Egress is $0.02/GB and storage is $0.01/GB.",
    "It runs $203/month vs $150/month.",
    "Pricing tiers: $5-$10 per seat.",
    "Costs $50/$60 depending on region.",
    "Item A ($5) and Item B ($10).",
    "We charge US$100 and CA$200.",
    "Between $1 million and $2 million in ARR.",
    "He paid 5$ and I paid 10$.",
    "Budget: $1,250.50 today, $3.2M next year.",
    "Item A ($5) and Item B ($x).",
    "Rates: ($5)/($x) per unit.",
    "Tiers ($10)-($n) apply.",
    // shell and ticker prose
    "Set $HOME and $PATH before running.",
    "Export $USER then check $SHELL.",
    "Use $HOME/$USER as the target directory.",
    "Prepend $PATH:$HOME to the search path.",
    'Set PS1="$USER@$HOST" in your profile.',
    "Check $JAVA_HOME and $MAVEN_HOME are set.",
    "Compare $HOME,$PATH ordering.",
    "Try $FOO;$BAR in one line.",
    "The var $A and the var $B differ.",
    "The ticker is $AAPL and $MSFT today.",
    "Use $1 and $2 as positional args in bash.",
    "Save $$ on your bill.",
  ])("renders no math in: %s", (markdown) => {
    const { container } = renderResponse(markdown);
    expect(container.querySelector(".katex")).toBeNull();
  });

  it.each([
    "The value $x$ is positive.",
    "We know $a + b$ equals the total.",
    "Let $x^2$ denote the square.",
    "Here $\\frac{1}{2}$ is one half.",
    "Given $n$ items and $k$ buckets.",
    "Then $\\alpha$ and $\\beta$ are angles.",
    "Consider $f(x)$ over the interval.",
    "Segment $AB$ meets triangle $ABC$.",
    "Solve $x = y$ for x.",
    "The bound is $O(n \\log n)$ overall.",
    "Let $v_i$ be the i-th vector.",
    "Where $5x$ is the coefficient term.",
    "The answer is $42$ exactly.",
    "The ratio $a:b$ is fixed.",
    "Compute $a/b$ directly.",
    "Vector $\\vec{v}$ has norm $|v|$.",
    "Then $P(A \\cap B)$ is the joint.",
    "Let $x_1, x_2$ be the roots.",
    "The interval $[0, 1]$ is closed.",
    "Sum $\\sum_{i=1}^{n} i$ over all i.",
    "If $x$ is the price then $x = 5$ dollars.",
    "A $5 fee applies when $n$ exceeds the cap.",
  ])("renders math in: %s", (markdown) => {
    const { container } = renderResponse(markdown);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  // The prices above must survive as readable text, not just avoid becoming a
  // formula — the currency pass escapes them, and `\$` has to render as `$`.
  it("shows an escaped price as a plain dollar amount", () => {
    const { container } = renderResponse(
      "The plan costs $5 and the addon $10.",
    );
    expect(container.textContent).toBe("The plan costs $5 and the addon $10.");
  });

  // The stray-`$$` case: promoting under an open display delimiter let the
  // opener pair with the promoted one and swallow the prose between them.
  it("keeps prose intact next to a stray display delimiter", () => {
    const { container } = renderResponse("Save $$ when $x$ is high.");
    expect(container.textContent).toBe("Save $$ when $x$ is high.");
  });
});
