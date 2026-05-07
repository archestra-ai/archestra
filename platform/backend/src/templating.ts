import {
  extractSsoGroupsFromRenderedTemplate,
  isTruthyTemplateOutput,
  registerSsoTemplateHelpers,
  SYSTEM_PROMPT_HELPER_NAMES,
  type UserSystemPromptContext,
} from "@shared";
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
 * If the template fails to compile or render, returns the original string unchanged.
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

  try {
    const template = Handlebars.compile(systemPrompt, { noEscape: true });
    return template({ ...context, ...additionalContext });
  } catch (error) {
    logger.warn(
      { err: error },
      "Failed to render system prompt template, using raw template string",
    );
    return systemPrompt;
  }
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
