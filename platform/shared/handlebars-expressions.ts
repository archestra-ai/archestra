/**
 * Locating and neutralizing the individual expressions inside a Handlebars
 * template.
 *
 * Handlebars compiles a template as a single unit, so one malformed expression
 * anywhere aborts the whole render. For prompts — prose that happens to carry
 * template syntax — that is the wrong trade: it costs the author every
 * substitution that *would* have worked and ships raw `{{user.name}}` text to
 * the model. These helpers let a caller find the offending expressions so it
 * can render around them (backend) or warn about them before they are saved
 * (frontend).
 *
 * The Handlebars parser is injected rather than imported so this module stays
 * dependency-free and browser-safe; callers pass their own runtime.
 */

/** A single `{{...}}` occurrence and where it sits in the template. */
export interface TemplateExpression {
  /** Index of the first `{`. */
  start: number;
  /** Index just past the final `}`. */
  end: number;
  /** The full expression as written, braces included. */
  source: string;
  /** The text between the braces, trimmed. */
  body: string;
}

/** Parses a Handlebars template, throwing when it is syntactically invalid. */
type HandlebarsParser = (template: string) => unknown;

/**
 * Whether Handlebars rejects this expression on its own.
 *
 * Only syntax is considered: a helper that does not exist parses fine and fails
 * at render time, which is a different (and separately recoverable) problem.
 */
export function isUnparseableExpression(
  expression: TemplateExpression,
  parse: HandlebarsParser,
): boolean {
  const { body, source } = expression;

  // Comments never fail, and partials and block closers are only ever invalid
  // because of the tag that opened them.
  if (body.startsWith("!") || body.startsWith(">") || body.startsWith("/")) {
    return false;
  }

  // A block opener cannot parse alone; give it the closing tag it is missing.
  if (body.startsWith("#") || body.startsWith("^")) {
    const name = body.slice(1).trim().split(/[\s}]/)[0];
    if (!name) return false;
    return !canParse(`${source}{{/${name}}}`, parse);
  }

  return !canParse(source, parse);
}

/** Whether this expression opens, closes, or branches a block. */
export function isBlockExpression({ body }: TemplateExpression): boolean {
  return (
    body.startsWith("#") ||
    body.startsWith("^") ||
    body.startsWith("/") ||
    body === "else"
  );
}

/**
 * Prefix each expression the predicate selects with `\`, which Handlebars
 * renders as the literal expression text (the backslash itself is consumed).
 */
export function escapeTemplateExpressions(
  template: string,
  shouldEscape: (expression: TemplateExpression) => boolean,
): { template: string; escaped: string[] } {
  const escaped: string[] = [];
  let result = "";
  let copiedTo = 0;

  for (const expression of findTemplateExpressions(template)) {
    if (!shouldEscape(expression)) continue;
    escaped.push(expression.source);
    result += `${template.slice(copiedTo, expression.start)}\\`;
    copiedTo = expression.start;
  }

  return { template: result + template.slice(copiedTo), escaped };
}

/**
 * The expressions in a template that Handlebars cannot parse, as written.
 * These render as literal text rather than as values.
 */
export function findUnparseableExpressions(
  template: string,
  parse: HandlebarsParser,
): string[] {
  return findTemplateExpressions(template)
    .filter((expression) => isUnparseableExpression(expression, parse))
    .map((expression) => expression.source);
}

// ===== Internal helpers =====

/**
 * Locate the Handlebars expressions in a template.
 *
 * Deliberately conservative: an expression this misses is simply not reported,
 * which degrades to the caller's existing fallback rather than to wrong output.
 */
function findTemplateExpressions(template: string): TemplateExpression[] {
  const expressions: TemplateExpression[] = [];

  for (let i = 0; i < template.length - 1; i++) {
    if (template[i] !== "{" || template[i + 1] !== "{") continue;

    // An expression the author already escaped is literal text, not a template
    // expression, and must not be escaped a second time.
    if (template[i - 1] === "\\") continue;

    // `{{{value}}}` needs three closing braces, `{{value}}` two. Raw blocks
    // (`{{{{`) are left alone — skip the whole run so their inner braces are
    // not mistaken for a triple-stache.
    let braces = 0;
    while (template[i + braces] === "{") braces++;
    if (braces > 3) {
      i += braces - 1;
      continue;
    }

    const end = findExpressionEnd(template, i + braces, braces);
    if (end === -1) break; // Unterminated: nothing after it is parseable either.

    const source = template.slice(i, end);
    expressions.push({
      start: i,
      end,
      source,
      body: source.slice(braces, source.length - braces).trim(),
    });
    i = end - 1;
  }

  return expressions;
}

/**
 * Index just past the closing braces of an expression, or -1 when unterminated.
 * Quoted parameters may themselves contain braces (`{{helper "}}"}}`), so
 * string literals are skipped rather than scanned.
 */
function findExpressionEnd(
  template: string,
  from: number,
  braces: number,
): number {
  const closing = "}".repeat(braces);
  let quote: string | null = null;

  for (let i = from; i < template.length; i++) {
    const char = template[i];

    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (template.startsWith(closing, i)) return i + braces;
  }

  return -1;
}

function canParse(template: string, parse: HandlebarsParser): boolean {
  try {
    parse(template);
    return true;
  } catch {
    return false;
  }
}
