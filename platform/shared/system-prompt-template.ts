/**
 * System prompt template variables and helpers available for Handlebars templating.
 * Used by both the backend (for rendering) and frontend (for documentation/UI hints).
 */

export const SYSTEM_PROMPT_VARIABLES = [
  {
    expression: "{{user.name}}",
    description: "Name of the user invoking the agent",
  },
  {
    expression: "{{user.email}}",
    description: "Email of the user invoking the agent",
  },
  {
    expression: "{{user.teams}}",
    description: "Team names the user belongs to (array)",
  },
] as const;

export const SYSTEM_PROMPT_HELPERS = [
  {
    expression: "{{currentDate}}",
    description: "Current date in UTC (YYYY-MM-DD)",
  },
  {
    expression: "{{currentTime}}",
    description: "Current time in UTC (HH:MM:SS UTC)",
  },
] as const;

/**
 * All available template expressions (variables + helpers) for display in the UI.
 */
export const SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS = [
  ...SYSTEM_PROMPT_VARIABLES,
  ...SYSTEM_PROMPT_HELPERS,
] as const;
