// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { Permissions } from "./permission.types";

/**
 * Fixed roles: small, built-in roles that each grant one slice of the
 * permission map, such as "Agent Reader" or "MCP Gateway Writer". Like
 * Grafana's fixed roles, they exist so an organization can compose exactly
 * the access a person, team, or service account needs from parts it does not
 * have to author, and so the four basic roles stop being the only shortcut.
 *
 * They are code-defined and immutable: no row in `organization_role`, the
 * same in every organization, resolved wherever a role identifier is
 * (`OrganizationRoleModel`). Their identifiers contain a colon, which
 * `generateRoleIdentifier` never produces, so a custom role cannot collide
 * with one.
 *
 * Every permission is listed explicitly rather than derived, so a reviewer
 * reads what each role grants here. `fixed-roles.test.ts` checks the
 * catalog against `allAvailableActions`: every grantable action is reachable
 * through some fixed role, and no role names an action that does not exist.
 */
export interface FixedRole {
  /** Immutable identifier, e.g. `fixed:agents:reader`. */
  role: string;
  /** Display name, e.g. "Agent Reader". */
  name: string;
  description: string;
  /** Id of the {@link FixedRoleGroup} it belongs to. */
  group: string;
  permission: Permissions;
}

export interface FixedRoleGroup {
  id: string;
  name: string;
  roles: FixedRole[];
}

export const FIXED_ROLE_PREFIX = "fixed:";

export const fixedRoleGroups: FixedRoleGroup[] = [
  group("agents", "Agents", [
    role(
      "agents:reader",
      "Agent Reader",
      "Open Agents and use the agents shared with you",
      { agent: ["read"] },
    ),
    role(
      "agents:writer",
      "Agent Writer",
      "Create agents and manage the deleted ones",
      { agent: ["read", "create", "delete"] },
    ),
    role(
      "agents:runtime-configurator",
      "Agent Runtime Configurator",
      "Create runtime-backed agents and change their runtime configuration",
      { agent: ["read", "configure-runtime"] },
    ),
  ]),
  group("skills", "Skills", [
    role("skills:reader", "Skill Reader", "Open Skills", { skill: ["read"] }),
    role(
      "skills:writer",
      "Skill Writer",
      "Create skills and delete them from the trash",
      { skill: ["read", "create", "delete"] },
    ),
  ]),
  group("plugins", "Plugins", [
    role("plugins:reader", "Plugin Reader", "View plugins and their files", {
      plugin: ["read"],
    }),
    role(
      "plugins:writer",
      "Plugin Writer",
      "Create, edit, and delete plugins",
      { plugin: ["read", "create", "update", "delete"] },
    ),
  ]),
  group("apps", "Apps", [
    role("apps:reader", "App Reader", "Open Apps", { app: ["read"] }),
    role("apps:writer", "App Writer", "Create MCP Apps", {
      app: ["read", "create"],
    }),
  ]),
  group("guardrails", "Guardrails", [
    role(
      "guardrails:reader",
      "Guardrails Reader",
      "View the Guardrails policy, batteries, and coverage",
      { guardrailsPolicy: ["read"] },
    ),
    role(
      "guardrails:writer",
      "Guardrails Writer",
      "Edit the Guardrails policy and manage batteries",
      { guardrailsPolicy: ["read", "update"] },
    ),
  ]),
  group("chat", "Chat & Projects", [
    role(
      "chat:user",
      "Chat User",
      "Start, edit, and delete your chat conversations",
      { chat: ["read", "create", "update", "delete"] },
    ),
    role(
      "chat:full-view",
      "Chat Full View",
      "Show the agent picker, model selectors, and tool call details in chat",
      { chat: ["read", "full-view"] },
    ),
    role(
      "projects:reader",
      "Project Reader",
      "View projects and their schedules",
      { project: ["read"] },
    ),
    role(
      "projects:writer",
      "Project Writer",
      "Create, edit, and delete projects and schedules",
      { project: ["read", "create", "update", "delete"] },
    ),
  ]),
  group("knowledge", "Knowledge", [
    role(
      "knowledge:reader",
      "Knowledge Reader",
      "View and query Knowledge Bases and Connectors",
      { knowledgeSource: ["read", "query"] },
    ),
    role(
      "knowledge:writer",
      "Knowledge Writer",
      "Create, edit, and delete Knowledge Bases and Connectors",
      { knowledgeSource: ["read", "create", "update", "delete", "query"] },
    ),
  ]),
  group("mcp", "MCP", [
    role("mcp-gateways:reader", "MCP Gateway Reader", "Open MCP Gateways", {
      mcpGateway: ["read"],
    }),
    role(
      "mcp-gateways:writer",
      "MCP Gateway Writer",
      "Create MCP Gateways and manage the deleted ones",
      { mcpGateway: ["read", "create", "delete"] },
    ),
    role(
      "mcp-registry:reader",
      "MCP Registry Reader",
      "Open the MCP Registry and use its built-in servers",
      { mcpRegistry: ["read"] },
    ),
    role(
      "mcp-registry:writer",
      "MCP Registry Writer",
      "Add servers to the MCP Registry",
      { mcpRegistry: ["read", "create"] },
    ),
    role(
      "mcp-servers:reader",
      "MCP Server Reader",
      "View installed MCP servers and their status",
      { mcpServerInstallation: ["read"] },
    ),
    role(
      "mcp-servers:writer",
      "MCP Server Writer",
      "Install, configure, and uninstall MCP servers",
      { mcpServerInstallation: ["read", "create", "update", "delete"] },
    ),
  ]),
  group("environments", "Environments", [
    role(
      "environments:reader",
      "Environment Reader",
      "View deployment environments",
      { environment: ["read"] },
    ),
    role(
      "environments:writer",
      "Environment Writer",
      "Create, edit, and delete deployment environments",
      { environment: ["read", "create", "update", "delete"] },
    ),
  ]),
  group("llm", "LLM", [
    role(
      "llm-proxy:reader",
      "LLM Proxy Reader",
      "View the LLM Proxy and its connection details",
      { llmProxy: ["read"] },
    ),
    role(
      "llm-proxy:writer",
      "LLM Proxy Writer",
      "Change the LLM Proxy configuration",
      { llmProxy: ["read", "update"] },
    ),
    role(
      "llm-provider-keys:reader",
      "Provider Key Reader",
      "Open LLM provider API keys",
      { llmProviderApiKey: ["read"] },
    ),
    role(
      "llm-provider-keys:writer",
      "Provider Key Writer",
      "Add LLM provider API keys",
      { llmProviderApiKey: ["read", "create"] },
    ),
    role(
      "llm-virtual-keys:reader",
      "Virtual Key Reader",
      "Open LLM virtual keys",
      { llmVirtualKey: ["read"] },
    ),
    role(
      "llm-virtual-keys:writer",
      "Virtual Key Writer",
      "Create LLM virtual keys",
      { llmVirtualKey: ["read", "create"] },
    ),
    role(
      "llm-models:reader",
      "Model Reader",
      "View synced models and their capabilities",
      { llmModel: ["read"] },
    ),
    role(
      "llm-models:writer",
      "Model Writer",
      "Sync the model catalog and edit every model",
      { llmModel: ["read", "update"] },
    ),
  ]),
  group("llm-usage", "LLM Costs & Limits", [
    role(
      "llm-costs:reader",
      "Cost Reader",
      "View organization-wide LLM cost statistics",
      { llmCost: ["read"] },
    ),
    role("llm-limits:reader", "Limit Reader", "View token and spend limits", {
      llmLimit: ["read"],
    }),
    role(
      "llm-limits:writer",
      "Limit Writer",
      "Create, edit, and remove token and spend limits",
      { llmLimit: ["read", "create", "update", "delete"] },
    ),
  ]),
  group("logs", "Logs & Audit", [
    role(
      "logs:reader",
      "Log Reader",
      "View your own LLM, MCP, and Guardrails logs",
      { log: ["read"] },
    ),
    role(
      "logs:admin",
      "Log Admin",
      "View every LLM, MCP, and Guardrails log in the organization",
      { log: ["read", "admin"] },
    ),
    role(
      "audit-log:reader",
      "Audit Log Reader",
      "View audit records of your own administrative actions",
      { auditLog: ["read"] },
    ),
    role(
      "audit-log:admin",
      "Audit Log Admin",
      "View every audit event in the organization",
      { auditLog: ["read", "admin"] },
    ),
  ]),
  group("users", "Users & Teams", [
    role("users:reader", "User Reader", "View members and their roles", {
      member: ["read"],
    }),
    role("users:writer", "User Writer", "Invite, edit, and remove members", {
      member: ["read", "create", "update", "delete"],
    }),
    role(
      "users:impersonator",
      "User Impersonator",
      "Sign in as another member to see the app with their access",
      { member: ["read", "impersonate"] },
    ),
    role("teams:reader", "Team Reader", "View teams and their members", {
      team: ["read"],
    }),
    role("teams:writer", "Team Writer", "Create, edit, and delete teams", {
      team: ["read", "create", "update", "delete"],
    }),
  ]),
  group("access", "Roles & Access", [
    role("roles:reader", "Role Reader", "View roles and their permissions", {
      ac: ["read"],
    }),
    role(
      "roles:writer",
      "Role Writer",
      "Create, edit, and delete custom roles",
      { ac: ["read", "create", "update", "delete"] },
    ),
    role(
      "access-policies:reader",
      "Access Policy Reader",
      "View access policies for every resource type",
      { accessPolicies: ["read"] },
    ),
    role(
      "access-policies:writer",
      "Access Policy Writer",
      "Edit access policies and grant access across every resource type",
      { accessPolicies: ["read", "update"] },
    ),
    role(
      "identity-providers:reader",
      "Identity Provider Reader",
      "View single sign-on configurations",
      { identityProvider: ["read"] },
    ),
    role(
      "identity-providers:writer",
      "Identity Provider Writer",
      "Set up, edit, and remove identity providers",
      { identityProvider: ["read", "create", "update", "delete"] },
    ),
  ]),
  group("api-access", "API Access", [
    role("api-keys:reader", "API Key Reader", "View your API keys", {
      apiKey: ["read"],
    }),
    role(
      "api-keys:writer",
      "API Key Writer",
      "Create and delete your API keys",
      { apiKey: ["read", "create", "delete"] },
    ),
    role(
      "service-accounts:reader",
      "Service Account Reader",
      "Open Service Accounts",
      { serviceAccount: ["read"] },
    ),
    role(
      "service-accounts:writer",
      "Service Account Writer",
      "Create service accounts",
      { serviceAccount: ["read", "create"] },
    ),
    role(
      "oauth-clients:reader",
      "OAuth Client Reader",
      "Open OAuth client registrations",
      { oauthClient: ["read"] },
    ),
    role(
      "oauth-clients:writer",
      "OAuth Client Writer",
      "Register OAuth clients",
      { oauthClient: ["read", "create"] },
    ),
    role("credentials:reader", "Credential Reader", "Open Credentials", {
      credential: ["read"],
    }),
    role(
      "credentials:writer",
      "Credential Writer",
      "Create saved credentials",
      { credential: ["read", "create"] },
    ),
  ]),
  group("organization", "Organization", [
    role(
      "organization-settings:reader",
      "Organization Settings Reader",
      "View every organization settings page",
      { organizationSettings: ["read"] },
    ),
    role(
      "organization-settings:writer",
      "Organization Settings Writer",
      "Change organization settings, messaging channels, and notifications",
      { organizationSettings: ["read", "update"] },
    ),
  ]),
];

export const fixedRoles: FixedRole[] = fixedRoleGroups.flatMap(
  (entry) => entry.roles,
);

export function isFixedRoleIdentifier(identifier: string): boolean {
  return identifier.startsWith(FIXED_ROLE_PREFIX);
}

export function getFixedRole(identifier: string): FixedRole | undefined {
  return FIXED_ROLES_BY_IDENTIFIER.get(identifier);
}

// === Internal helpers

const FIXED_ROLES_BY_IDENTIFIER = new Map(
  fixedRoles.map((entry) => [entry.role, entry]),
);

function group(
  id: string,
  name: string,
  roles: Omit<FixedRole, "group">[],
): FixedRoleGroup {
  return { id, name, roles: roles.map((entry) => ({ ...entry, group: id })) };
}

function role(
  slug: string,
  name: string,
  description: string,
  permission: Permissions,
): Omit<FixedRole, "group"> {
  return {
    role: `${FIXED_ROLE_PREFIX}${slug}`,
    name,
    description,
    permission,
  };
}
