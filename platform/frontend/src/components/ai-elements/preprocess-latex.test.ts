import { describe, expect, it } from "vitest";
import { preprocessLaTeX } from "./preprocess-latex";

describe("preprocessLaTeX", () => {
  // The failure this exists for: models write inline math as `$x$`, which
  // remark-math ignores while singleDollarTextMath is off.
  it.each([
    ["a bare span", "$X$", "$$X$$"],
    ["inside bold", "**Moment $E[X_i^2]$**:", "**Moment $$E[X_i^2]$$**:"],
    ["in a heading", "### Variance of $X$", "### Variance of $$X$$"],
    ["a macro body", "$\\binom{n}{k}$ ways", "$$\\binom{n}{k}$$ ways"],
    [
      "a span with spaces and parens",
      "Let $\\text{Var}(X_i) = p(1 - p)$:",
      "Let $$\\text{Var}(X_i) = p(1 - p)$$:",
    ],
    ["two spans on a line", "$a$ then $b$", "$$a$$ then $$b$$"],
  ])("promotes %s to display delimiters", (_label, input, expected) => {
    expect(preprocessLaTeX(input)).toBe(expected);
  });

  // Currency is the reason single-dollar math cannot simply be switched on.
  it.each([
    ["whole amounts", "costs $5 and $10", "costs \\$5 and \\$10"],
    ["thousands and cents", "was $1,250.50 last", "was \\$1,250.50 last"],
    ["a magnitude suffix", "raised $3.2M total", "raised \\$3.2M total"],
    ["an amount ending a line", "the price is $99", "the price is \\$99"],
  ])("escapes %s", (_label, input, expected) => {
    expect(preprocessLaTeX(input)).toBe(expected);
  });

  // Both in one line is the case a delimiter-only rule cannot get right.
  it("separates a price from real math on the same line", () => {
    expect(preprocessLaTeX("Costs $5, and $x^2$ is the formula")).toBe(
      "Costs \\$5, and $$x^2$$ is the formula",
    );
  });

  // Pandoc's rule: what sits *next to* the delimiters decides, so prose that
  // merely happens to contain two dollars is not a formula. Asserted as "no
  // `$$` was produced" because the currency pass legitimately rewrites some of
  // these to `\$`, which still renders as the literal price.
  it.each([
    ["a space before the closer", "Set $HOME and $PATH before running."],
    ["a space before the closer, twice", "Export $USER then check $SHELL."],
    ["underscored env vars", "Check $JAVA_HOME and $MAVEN_HOME are set."],
    ["single-letter vars", "The var $A and the var $B differ."],
    ["postfix amounts", "He paid 5$ and I paid 10$."],
    ["a digit after the closer", "Item A ($5) and Item B ($10)."],
    ["a hyphenated range", "Pricing tiers: $5-$10 per seat."],
    ["a slash-separated range", "Costs $50/$60 depending on region."],
    ["tickers", "The ticker is $AAPL and $MSFT today."],
    ["positional shell args", "Use $1 and $2 as positional args in bash."],
    ["a price then a variable", "Item A ($5) and Item B ($x)."],
    ["a price then a variable in a ratio", "Rates: ($5)/($x) per unit."],
  ])("does not promote %s", (_label, input) => {
    expect(preprocessLaTeX(input)).not.toContain("$$");
  });

  // Rule 2 alone would pair these: the closing candidate is pinned against
  // punctuation rather than a space, so it satisfies Pandoc on its own.
  it.each([
    ["a path separator", "Use $HOME/$USER as the target directory."],
    ["a colon", "Prepend $PATH:$HOME to the search path."],
    ["an at sign", 'Set PS1="$USER@$HOST" in your profile.'],
    ["a comma", "Compare $HOME,$PATH ordering."],
    ["a semicolon", "Try $FOO;$BAR in one line."],
  ])("does not promote across %s", (_label, input) => {
    expect(preprocessLaTeX(input)).not.toContain("$$");
  });

  // A number closed by a `$` is a formula, not a price, so the currency pass
  // has to stand down for it.
  it("promotes a numeric formula that closes on a dollar", () => {
    expect(preprocessLaTeX("The answer is $42$ exactly.")).toBe(
      "The answer is $$42$$ exactly.",
    );
  });

  // A promoted pair inserted under an open `$$` gets eaten by it: the stray
  // opener pairs with our opening `$$` and the prose between them becomes the
  // formula. Declining to promote leaves the span as the literal text instead.
  it("declines to promote under an unclosed display delimiter", () => {
    const input = "Save $$ when $x$ is high.";
    expect(preprocessLaTeX(input)).toBe(input);
  });

  it("resumes promoting in the next paragraph", () => {
    expect(preprocessLaTeX("Save $$ today.\n\nThen $x$ holds.")).toBe(
      "Save $$ today.\n\nThen $$x$$ holds.",
    );
  });

  it.each([
    ["existing display math", "$$\nE = mc^2\n$$"],
    ["a fenced code block", "```sh\necho $HOME and $PATH\n```"],
    ["an inline code span", "use `$5` verbatim"],
    ["text with no dollars", "just a sentence"],
  ])("leaves %s unchanged", (_label, input) => {
    expect(preprocessLaTeX(input)).toBe(input);
  });

  // Upstream drops an unterminated fence, which is the normal state of a reply
  // that is still streaming — its contents would be rewritten mid-render.
  it("protects a fence that has not closed yet", () => {
    const input = "```py\nprice = $5\ncmd = $HOME$PATH";
    expect(preprocessLaTeX(input)).toBe(input);
  });

  it("rewrites math that follows a closed code block", () => {
    expect(preprocessLaTeX("```\n$5\n```\n\n$x^2$")).toBe(
      "```\n$5\n```\n\n$$x^2$$",
    );
  });

  // Upstream doubles the backslash on mhchem commands, and KaTeX reads `\\` as
  // a line break — the formula came out as stray letters with no error to show
  // for it. That branch is not vendored, so the command reaches KaTeX intact.
  it.each([
    ["ce", "$\\ce{H2O}$ is water", "$$\\ce{H2O}$$ is water"],
    ["pu", "mass $\\pu{123 kg}$ here", "mass $$\\pu{123 kg}$$ here"],
  ])("leaves a \\%s command's backslash alone", (_label, input, expected) => {
    expect(preprocessLaTeX(input)).toBe(expected);
  });
});
