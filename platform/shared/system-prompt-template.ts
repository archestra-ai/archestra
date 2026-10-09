const USER_SYSTEM_PROMPT_CONTEXT_KEY = "user";
const toTemplateExpression = (path: string) => `{{${path}}}`;

export const SYSTEM_PROMPT_VARIABLE_PATHS = {
  userName: `${USER_SYSTEM_PROMPT_CONTEXT_KEY}.name`,
  userEmail: `${USER_SYSTEM_PROMPT_CONTEXT_KEY}.email`,
  userRole: `${USER_SYSTEM_PROMPT_CONTEXT_KEY}.role`,
  userTeams: `${USER_SYSTEM_PROMPT_CONTEXT_KEY}.teams`,
} as const;

export const SYSTEM_PROMPT_VARIABLE_EXPRESSIONS = {
  userName: toTemplateExpression(SYSTEM_PROMPT_VARIABLE_PATHS.userName),
  userEmail: toTemplateExpression(SYSTEM_PROMPT_VARIABLE_PATHS.userEmail),
  userRole: toTemplateExpression(SYSTEM_PROMPT_VARIABLE_PATHS.userRole),
  userTeams: toTemplateExpression(SYSTEM_PROMPT_VARIABLE_PATHS.userTeams),
} as const;

/**
 * System prompt template variables and helpers available for Handlebars templating.
 * Used by both the backend (for rendering) and frontend (for documentation/UI hints).
 */

export const SYSTEM_PROMPT_VARIABLES = [
  {
    expression: SYSTEM_PROMPT_VARIABLE_EXPRESSIONS.userName,
    description: "Name of the user invoking the agent",
  },
  {
    expression: SYSTEM_PROMPT_VARIABLE_EXPRESSIONS.userEmail,
    description: "Email of the user invoking the agent",
  },
  {
    expression: SYSTEM_PROMPT_VARIABLE_EXPRESSIONS.userRole,
    description: "Organization role of the user invoking the agent",
  },
  {
    expression: SYSTEM_PROMPT_VARIABLE_EXPRESSIONS.userTeams,
    description: "Team names the user belongs to (array)",
  },
] as const;

export const SYSTEM_PROMPT_HELPER_NAMES = {
  currentDate: "currentDate",
  currentTime: "currentTime",
} as const;

export const SYSTEM_PROMPT_HELPER_EXPRESSIONS = {
  currentDate: toTemplateExpression(SYSTEM_PROMPT_HELPER_NAMES.currentDate),
  currentTime: toTemplateExpression(SYSTEM_PROMPT_HELPER_NAMES.currentTime),
} as const;

export const SYSTEM_PROMPT_HELPERS = [
  {
    expression: SYSTEM_PROMPT_HELPER_EXPRESSIONS.currentDate,
    description: "Current date in UTC (YYYY-MM-DD)",
  },
  {
    expression: SYSTEM_PROMPT_HELPER_EXPRESSIONS.currentTime,
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

export interface UserSystemPromptContext {
  user: {
    name: string;
    email: string;
    /**
     * The user's organization role. Empty when the caller has no membership to
     * resolve it from (e.g. an autonomous run acting outside a member context),
     * so a prompt branching on it degrades to "no role" rather than to a leak.
     */
    role: string;
    teams: string[];
  };
}

export function buildUserSystemPromptContext(params: {
  userName: string;
  userEmail: string;
  userRole?: string | null;
  userTeams: string[];
}): UserSystemPromptContext {
  return {
    [USER_SYSTEM_PROMPT_CONTEXT_KEY]: {
      name: params.userName,
      email: params.userEmail,
      role: params.userRole ?? "",
      teams: params.userTeams,
    },
  };
}

export function getSystemPromptTemplateExpressions() {
  return SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS;
}
