import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import Handlebars from "handlebars";
import type { CommonToolResult } from "@/types";

/**
 * Register custom Handlebars helpers for template rendering
 */
Handlebars.registerHelper("json", (context) => {
  // If context is a string, try to parse it as JSON
  if (typeof context === "string") {
    try {
      return JSON.parse(context);
    } catch {
      // If not valid JSON, return the string as-is
      return context;
    }
  }
  // If context is an object, stringify it
  return JSON.stringify(context);
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
 * SSO-specific Handlebars helpers
 */

// Check if an array includes a value (case-insensitive for strings)
Handlebars.registerHelper(
  "includes",
  function (
    this: unknown,
    array: unknown,
    value: unknown,
    options: Handlebars.HelperOptions,
  ) {
    if (!Array.isArray(array)) return options.inverse(this);
    const found = array.some((item) => {
      if (typeof item === "string" && typeof value === "string") {
        return item.toLowerCase() === value.toLowerCase();
      }
      return item === value;
    });
    return found ? options.fn(this) : options.inverse(this);
  },
);

// Check if a string contains a substring (case-insensitive)
Handlebars.registerHelper(
  "contains",
  function (
    this: unknown,
    str: unknown,
    substring: unknown,
    options: Handlebars.HelperOptions,
  ) {
    if (typeof str !== "string" || typeof substring !== "string") {
      return options.inverse(this);
    }
    return str.toLowerCase().includes(substring.toLowerCase())
      ? options.fn(this)
      : options.inverse(this);
  },
);

// Check equality
Handlebars.registerHelper(
  "equals",
  function (
    this: unknown,
    a: unknown,
    b: unknown,
    options: Handlebars.HelperOptions,
  ) {
    if (typeof a === "string" && typeof b === "string") {
      return a.toLowerCase() === b.toLowerCase()
        ? options.fn(this)
        : options.inverse(this);
    }
    return a === b ? options.fn(this) : options.inverse(this);
  },
);

// Logical AND
Handlebars.registerHelper("and", function (this: unknown, ...args: unknown[]) {
  const options = args.pop() as Handlebars.HelperOptions;
  return args.every(Boolean) ? options.fn(this) : options.inverse(this);
});

// Logical OR
Handlebars.registerHelper("or", function (this: unknown, ...args: unknown[]) {
  const options = args.pop() as Handlebars.HelperOptions;
  return args.some(Boolean) ? options.fn(this) : options.inverse(this);
});

// Not equal
Handlebars.registerHelper(
  "notEquals",
  function (
    this: unknown,
    a: unknown,
    b: unknown,
    options: Handlebars.HelperOptions,
  ) {
    if (typeof a === "string" && typeof b === "string") {
      return a.toLowerCase() !== b.toLowerCase()
        ? options.fn(this)
        : options.inverse(this);
    }
    return a !== b ? options.fn(this) : options.inverse(this);
  },
);

// Check if value exists (not null/undefined)
Handlebars.registerHelper(
  "exists",
  function (this: unknown, value: unknown, options: Handlebars.HelperOptions) {
    return value !== null && value !== undefined
      ? options.fn(this)
      : options.inverse(this);
  },
);

// Extract a property from each item in an array
Handlebars.registerHelper("pluck", (array, property) => {
  if (!Array.isArray(array)) return [];
  return array
    .map((item) => (typeof item === "object" && item ? item[property] : null))
    .filter((v) => v !== null && v !== undefined);
});

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
    const template = Handlebars.compile(templateString);
    const result = template(context).trim();
    // Consider any non-empty string as truthy
    return result.length > 0 && result !== "false" && result !== "0";
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
  const template = Handlebars.compile(templateString);

  try {
    const result = template(context).trim();

    if (!result) return [];

    // Try to parse as JSON array first
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((v) => typeof v === "string" && v.trim())
          .map((v) => v.trim());
      }
    } catch {
      // Not JSON, treat as comma-separated
    }

    // Split by comma and clean up
    return result
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // Runtime error during template execution
    return [];
  }
}

/**
 * Apply a handlebars template to transform a tool response
 *
 * The content from MCP tools will look like:
 * https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools
 *
 * @param templateString - Handlebars template string
 * @param toolCallResponseResultContent - The content returned from an MCP tool call
 * @returns Transformed content (parsed JSON or original content on failure)
 */
export function applyResponseModifierTemplate(
  templateString: string,
  toolCallResponseResultContent: Awaited<
    ReturnType<typeof Client.prototype.callTool>
  >["content"],
): CommonToolResult["content"] {
  try {
    const template = Handlebars.compile(templateString);

    // Render the template with the response as context
    const rendered = template({ response: toolCallResponseResultContent });

    // Try to parse as JSON if possible, otherwise return as text
    try {
      return JSON.parse(rendered);
    } catch {
      // If it's not valid JSON, return as a text content block
      return [{ type: "text", text: rendered }];
    }
  } catch {
    // If template compilation or rendering fails, return original content
    return toolCallResponseResultContent;
  }
}
