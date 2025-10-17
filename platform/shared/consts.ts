// ids used for demo pages and seeding DB
export const DEMO_AGENT_ID = "be7a5556-9d4e-45a6-956f-82c07c4f8f8f";
export const BLOCKED_DEMO_AGENT_ID = "91c561cd-547a-423a-b563-3ce9031a66b6";
export const ALLOWED_DEMO_TOOL_IDS = {
  sendEmail: "6fd5a5b1-751b-47f7-b806-f54842b3da85",
  getEmails: "dcacf636-658f-42fe-bb43-25ec594c0592",
};
export const BLOCKED_DEMO_TOOL_IDS = {
  sendEmails: "56c09564-fe92-4a28-ad66-87d40599f971",
  getMyEmails: "ca152b02-767e-48d3-9ba6-8a7ac56c897d",
};
export const ALLOWED_DEMO_INTERACTION_ID = "293bfa6f-afef-4631-96c9-22891c4d60e6";
export const BLOCKED_DEMO_INTERACTION_ID = "df5e094d-bbb8-4837-ba28-1761cfb714b6";

export const E2eTestId = {
  AgentsTable: "agents-table",
  CreateAgentButton: "create-agent-button",
  DeleteAgentButton: "delete-agent-button",
} as const;
export type E2eTestId = (typeof E2eTestId)[keyof typeof E2eTestId];

export const DEFAULT_ADMIN_EMAIL = "admin@localhost.ai";
export const DEFAULT_ADMIN_PASSWORD = "password";

export const DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME = "ARCHESTRA_AUTH_ADMIN_EMAIL";
export const DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME = "ARCHESTRA_AUTH_ADMIN_PASSWORD";

export const DEFAULT_AGENT_NAME = "Default Agent with Archestra";
