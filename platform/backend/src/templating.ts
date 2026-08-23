import {
  escapeTemplateExpressions,
  extractSsoGroupsFromRenderedTemplate,
  isBlockExpression,
  isTruthyTemplateOutput,
  isUnparseableExpression,
  registerSsoTemplateHelpers,
  SYSTEM_PROMPT_HELPER_NAMES,
  type TemplateExpression,
  type UserSystemPromptContext,
} from "@archestra/shared";
import Handlebars from "handlebars";
import logger from "@/logging";

/**
 * Register custom Handlebars helpers for template rendering
 */
registerSsoTemplateHelpers({
  registerHelper: (name, helper) => {
    Handlebars.registerHelper(name, helper);
  },
});

// Helper to escape strings for use in JSON
Handlebars.registerHelper("escapeJson", (str) => {
  if (typeof str !== "string") return str;
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
});

/**
 * System prompt template helpers
 */

// Returns the current date in YYYY-MM-DD format (UTC)
Handlebars.registerHelper(SYSTEM_PROMPT_HELPER_NAMES.currentDate, () => {
  return new Date().toISOString().split("T")[0];
});

// Returns the current time in HH:MM:SS UTC format
Handlebars.registerHelper(SYSTEM_PROMPT_HELPER_NAMES.currentTime, () => {
  return `${new Date().toISOString().split("T")[1].split(".")[0]} UTC`;
});

/**
 * Check if any of the given prompt strings contain Handlebars syntax (`{{`).
 * Used to skip unnecessary DB queries (e.g. fetching user teams) when no
 * templating is needed.
 */
export function promptNeedsRendering(
  ...prompts: (string | null | undefined)[]
): boolean {
  return prompts.some((p) => p?.includes("{{"));
}

/**
 * Render an agent's system prompt, applying Handlebars template variables
 * (e.g. {{user.name}}) when present. Returns null if no system prompt is set.
 *
 * Rendering is deliberately resilient. A Handlebars template is compiled as a
 * single unit, so one malformed expression anywhere in the prompt aborts the
 * whole render — and a prompt that renders raw ships every *valid* expression
 * to the model as literal `{{user.name}}` text. Authors write prose, not
 * programs: prompts routinely document their own variables (`{{user.*}}`) or
 * quote another engine's syntax, and neither should cost them the substitutions
 * that do work. So an expression Handlebars cannot parse is escaped to the
 * literal text the author typed, and everything around it still renders.
 *
 * @param additionalContext - Optional extra context merged alongside user context.
 *   Used by specific subagents (e.g. policy configuration) to inject agent-specific
 *   template variables without polluting the shared UserSystemPromptContext interface.
 */
export function renderSystemPrompt(
  systemPrompt: string | null,
  context?: UserSystemPromptContext | null,
  additionalContext?: Record<string, unknown>,
): string | null {
  if (!systemPrompt) {
    return null;
  } else if (!context && !additionalContext) {
    return systemPrompt;
  }

  const data = { ...context, ...additionalContext };

  const direct = tryRender(systemPrompt, data);
  if (direct.ok) {
    return direct.output;
  }

  // Escape the individual expressions that cannot parse on their own — the
  // common case, and the one that leaves every other variable substitutable.
  const { template: repaired, escaped } = escapeTemplateExpressions(
    systemPrompt,
    cannotParse,
  );
  if (escaped.length > 0) {
    const partial = tryRender(repaired, data);
    if (partial.ok) {
      logUnrenderable(escaped, direct.error);
      return partial.output;
    }
  }

  // Still failing: the damage is structural (an unclosed block, or a block
  // helper that does not exist) rather than a single bad expression. Escaping
  // every block token leaves the block syntax visible as written while the
  // plain variables around it — the ones users actually notice leaking — render.
  const { template: blocksEscaped, escaped: escapedBlocks } =
    escapeTemplateExpressions(repaired, isBlockExpression);
  if (escapedBlocks.length > 0) {
    const withoutBlocks = tryRender(blocksEscaped, data);
    if (withoutBlocks.ok) {
      logUnrenderable([...escaped, ...escapedBlocks], direct.error);
      return withoutBlocks.output;
    }
  }

  logger.warn(
    { err: direct.error },
    "Failed to render system prompt template, using raw template string",
  );
  return systemPrompt;
}

/**
 * Evaluate a Handlebars template for SSO role mapping.
 * Returns true if the template renders to a truthy value (non-empty string).
 *
 * @param templateString - Handlebars template that should render to "true" or truthy content when matched
 * @param context - SSO claims data to evaluate against
 * @returns true if the template renders to a non-empty/truthy string
 */
export function evaluateRoleMappingTemplate(
  templateString: string,
  context: Record<string, unknown>,
): boolean {
  try {
    const template = Handlebars.compile(templateString, { noEscape: true });
    const result = template(context).trim();
    return isTruthyTemplateOutput(result);
  } catch {
    return false;
  }
}

/**
 * Extract group identifiers from SSO claims using a Handlebars template.
 * The template should render to a comma-separated list or JSON array of group names.
 *
 * @param templateString - Handlebars template that extracts group identifiers
 * @param context - SSO claims data
 * @returns Array of group identifier strings
 * @throws Error if the template fails to compile (allows caller to fall back)
 */
export function extractGroupsWithTemplate(
  templateString: string,
  context: Record<string, unknown>,
): string[] {
  // Compile template - let this throw on syntax errors so caller can fall back
  const template = Handlebars.compile(templateString, { noEscape: true });

  try {
    const result = template(context).trim();
    return extractSsoGroupsFromRenderedTemplate(result);
  } catch {
    // Runtime error during template execution
    return [];
  }
}

export type { UserSystemPromptContext };

// ===== Internal helpers =====

/** Most unrenderable expressions to name in a log line. */
const LOGGED_EXPRESSION_LIMIT = 10;

type RenderAttempt =
  | { ok: true; output: string }
  | { ok: false; error: unknown };

function tryRender(
  template: string,
  data: Record<string, unknown>,
): RenderAttempt {
  try {
    // Compilation is lazy: parse errors surface on first invocation, so both
    // steps have to sit inside the same try.
    return {
      ok: true,
      output: Handlebars.compile(template, { noEscape: true })(data),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Bind the shared syntax check to this module's Handlebars runtime. */
function cannotParse(expression: TemplateExpression): boolean {
  return isUnparseableExpression(expression, (template) =>
    Handlebars.parse(template),
  );
}

/**
 * Surface what was left literal. Admins otherwise only learn about it when a
 * model quotes `{{user.name}}` back at a user.
 */
function logUnrenderable(expressions: string[], error: unknown): void {
  logger.warn(
    {
      err: error,
      unrenderableExpressions: expressions.slice(0, LOGGED_EXPRESSION_LIMIT),
      unrenderableExpressionCount: expressions.length,
    },
    "System prompt contains template expressions Handlebars cannot render; they were left as literal text and the rest of the prompt was rendered",
  );
}
