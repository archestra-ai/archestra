import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ADMIN_ROLE_NAME,
  internalResources,
  PLATFORM_ADMIN_ROLE_NAME,
  type PredefinedRoleName,
  type Resource,
  resourceLabels,
  roleDescriptions,
} from "@archestra/shared";
import {
  allAvailableActions,
  permissionDescriptions,
  predefinedPermissionsMap,
} from "@archestra/shared/access-control";
import logger from "@/logging";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function generatePredefinedRolesSections(): string {
  const roles = Object.keys(predefinedPermissionsMap) as PredefinedRoleName[];
  const sections: string[] = [];

  for (const role of roles) {
    const permissions = predefinedPermissionsMap[role];
    const capitalizedName = role
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    let section = `### ${capitalizedName}\n\n`;
    section += `${roleDescriptions[role]}\n\n`;

    if (role === ADMIN_ROLE_NAME) {
      section += "The admin role has **all permissions** on every resource.\n";
    } else if (role === PLATFORM_ADMIN_ROLE_NAME) {
      section +=
        "Platform Admin holds **all permissions except** `log:admin`, " +
        "`auditLog:admin`, and `member:impersonate` — so holders run the " +
        "platform (users, roles, settings, resources) while other members' " +
        "LLM/MCP logs, the org-wide audit trail, and impersonation stay out " +
        "of reach. They keep `log:read` and `auditLog:read`, which show " +
        "**their own** records only. Combined with the " +
        "[no-privilege-escalation rule](#no-privilege-escalation), a " +
        "Platform Admin cannot grant themselves or anyone else a role " +
        "carrying the withheld permissions.\n";
    } else {
      section += "| Resource | Actions |\n";
      section += "|----------|--------|\n";

      for (const [resource, actions] of Object.entries(permissions)) {
        if (
          actions.length === 0 ||
          internalResources.includes(resource as Resource)
        ) {
          continue;
        }
        const label = resourceLabels[resource as Resource] || resource;
        const actionList = actions.map((a) => `\`${a}\``).join(", ");
        section += `| ${label} | ${actionList} |\n`;
      }
    }

    sections.push(section);
  }

  return sections.join("\n");
}

/**
 * Validates that every resource:action combination in allAvailableActions
 * has a corresponding entry in permissionDescriptions. Throws if any are missing.
 */
function validatePermissionDescriptions(): void {
  const missing: string[] = [];

  for (const resource of Object.keys(allAvailableActions) as Resource[]) {
    if (internalResources.includes(resource)) continue;

    for (const action of allAvailableActions[resource]) {
      const key = `${resource}:${action}`;
      if (!permissionDescriptions[key]) {
        missing.push(key);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing permission descriptions for: ${missing.join(", ")}. ` +
        "Add them to permissionDescriptions in shared/access-control.ts",
    );
  }
}

function generateCustomRolesPermissionsTable(): string {
  validatePermissionDescriptions();

  const resources = Object.keys(allAvailableActions) as Resource[];

  let table = "| Permission | Description |\n";
  table += "|------------|-------------|\n";

  for (const resource of resources
    .filter((r) => !internalResources.includes(r))
    .sort()) {
    const actions = allAvailableActions[resource];

    for (const action of actions) {
      const key = `${resource}:${action}`;
      table += `| \`${key}\` | ${permissionDescriptions[key]} |\n`;
    }
  }

  return table;
}

function generateScopedResourcesSection(): string {
  return `## Scoped Resources

Some resources use a two-step authorization model:

1. RBAC grants a base action such as \`read\`, \`create\`, \`update\`, or \`delete\`
2. Runtime scope rules further restrict which records a user can see or modify

The most common scopes are:

- \`personal\`: owned by one user
- \`team\`: shared with one or more teams
- \`org\`: shared across the organization

The elevated actions \`:admin\` and \`:team-admin\` are not global shortcuts with identical meaning on every resource. Their effect depends on the resource's runtime authorization rules.

### Team Roles

Team membership has its own role, separate from organization RBAC:

- \`member\`: belongs to the team and can access resources shared with that team
- \`admin\`: can manage membership and team-scoped settings for that team, such as external group sync mappings

Whoever creates a team joins it as that team's first admin, so they can manage its members straight away.

Team admins do **not** automatically receive organization-level team permissions. Renaming a team, editing its description, creating teams, and deleting teams require the matching organization RBAC permission such as \`team:update\`, \`team:create\`, or \`team:delete\`.

Team roles are also separate from resource actions named \`:team-admin\`. For example, \`agent:team-admin\` controls team-scoped agent management; it does not make the user an admin member of every team.

### Agents, MCP Gateways, and LLM Proxies

\`agent\`, \`mcpGateway\`, and \`llmProxy\` share the same scope model:

- \`personal\`: the author can manage their own records
- \`team\`: requires \`<resource>:team-admin\` and membership in at least one assigned team
- \`org\`: requires \`<resource>:admin\`

Examples:

- \`agent:delete\` alone does **not** allow deleting every agent
- \`agent:team-admin\` allows managing team-scoped agents only in teams the user belongs to
- \`agent:admin\` bypasses those scope restrictions

### Visibility-Scoped Credentials

\`llmProviderApiKey\` and \`llmVirtualKey\` also support \`personal\`, \`team\`, and \`org\` scope, but they use different elevated permissions:

- Personal records are limited to their owner
- Team records require membership in the selected team, with team member admins able to manage their own team
- Organization-wide records require the resource-specific admin permission such as \`llmProviderApiKey:admin\` or \`llmVirtualKey:admin\`

These resources do **not** use \`:team-admin\`.

### Team-Restricted Models

You can limit an LLM model to specific teams. Open the model on the Models page and pick teams under "Limit to teams" — dev teams get frontier models while test teams use cheaper ones, for example.

A model with no teams selected stays available to everyone. A restricted model is hidden from model pickers and \`/models\` listings for users outside its teams, and the LLM Proxy rejects their requests to it with \`403\`. Users with \`llmModel:update\`, including organization admins, keep full access.

### Chat Access And Optional UI Controls

Chat access is controlled separately from optional chat UI controls:

- \`chat:read\` allows access to chat itself
- \`agent:read\` is also required because chat is agent-backed and a user must be able to access at least one agent/profile context to start or use chat
- \`chatAgentPicker:enable\` controls whether the agent picker is visible
- \`chatProviderSettings:enable\` controls whether model and API key selectors are visible

The selector visibility permissions are UI toggles. They should be treated independently from core chat access and should not be assumed to grant access to provider credentials or model catalogs on their own.

### MCP Registry And Installation Records

Some MCP-related resources also apply runtime scope checks in addition to RBAC, but their rules differ from agents, MCP gateways, and LLM proxies:

- Internal MCP catalog items can be \`personal\`, \`team\`, or \`org\`
- Organization-wide catalog items require \`mcpServerInstallation:admin\`
- Team MCP server installations depend on team membership, with broader control for organization-level team managers and admins of the selected team

When designing custom roles, treat the permission matrix as the first gate and the resource's scope rules as the second gate.
`;
}

/**
 * Generate the frontmatter for the markdown file.
 * @param lastUpdated - The date string for the lastUpdated field
 */
function generateFrontmatter(lastUpdated: string): string {
  return `---
title: "Access Control"
category: Administration
description: "Role-based access control (RBAC) system for managing user permissions in Archestra"
order: 1
lastUpdated: ${lastUpdated}
---`;
}

/**
 * Generate the markdown body content (everything after frontmatter).
 */
function generateMarkdownBody(): string {
  return `
<!--
GENERATED FILE — edit codegen-access-control-docs.ts, not this page.
Run \`pnpm codegen:access-control-docs\` to regenerate.
Renaming/deleting this page? Add a redirect in docs/redirects.json.
-->

Archestra uses a role-based access control (RBAC) system to manage user permissions. This system provides both predefined roles for common use cases and the flexibility to create custom roles with specific permission combinations.

Permissions in Archestra are defined using a \`resource:action\` format, where:

- **Resource**: The type of object or feature being accessed (e.g., \`agent\`, \`mcpGateway\`, \`llmProxy\`)
- **Action**: The operation being performed (\`create\`, \`read\`, \`update\`, \`delete\`, \`admin\`)

For example, the permission \`agent:create\` allows creating new agents, \`mcpGateway:update\` allows updating MCP gateways, whereas \`llmProxy:read\` would allow reading LLM proxies.

Two resources distinguish an own-records view from an organization-wide one: \`log:read\` shows only the caller's own LLM proxy and MCP tool-call records, while \`log:admin\` shows every user's; \`auditLog:read\` and \`auditLog:admin\` split the audit trail the same way. This is what makes a deliberately-restricted admin role practical — its holders keep full visibility into their own activity without seeing anyone else's.

## Predefined Roles

The following roles are built into Archestra and cannot be modified or deleted:

${generatePredefinedRolesSections()}

## Custom Roles

Users with \`ac:create\` permission can create custom roles by selecting specific permission combinations. Custom roles allow fine-grained access control tailored to your needs.

#### No privilege escalation

A role can only be granted by someone who already holds every permission it carries. This single rule is enforced server-side on **every** grant path:

- creating or editing a custom role's permissions,
- changing a member's role,
- inviting a user with a role,
- setting the organization's default member role,
- creating or updating a service account.

The role pickers in the UI disable roles you cannot grant and explain which permissions you are missing. The rule is what makes deliberately-restricted admin roles trustworthy: an admin role created without, say, \`log:read\`, \`auditLog:read\`, and \`member:impersonate\` cannot be escaped by its holders — with \`member:update\` they can still manage users freely inside their own permission set, but any attempt to hand out (to themselves or anyone else) a role carrying the withheld permissions is rejected. Roles applied by an identity provider through [SSO role mapping](/docs/platform-sso-role-mapping) are the deliberate exception: they are granted by the IdP configuration, not by a platform user.

### Available Permissions

The following table lists all available permissions that can be assigned to custom roles:

${generateCustomRolesPermissionsTable()}

${generateScopedResourcesSection()}

## Best Practices

### Principle of Least Privilege

Grant users only the minimum permissions necessary for their role. Start with the "Member" role and add specific permissions as needed.

### Team-Based Organization

Combine roles with team-based access control for fine-grained resource access:

1. **Create teams** for different groups (e.g., "Data Scientists", "Developers")
2. **Assign Agents, MCP Gateways, LLM Proxies, and MCP Servers** to specific teams
3. **Add users to teams** based on their role and responsibilities

#### Default Team

New users are automatically added to the "Default Team" when they accept an invitation. This ensures all users have immediate access to Archestra resources assigned to this team.

#### Team Access Control Rules

**For MCP Gateways, LLM Proxies, and Agents:**

- Users can only see agents assigned to teams they belong to
- Exception: Users with \`agent:admin\` permission can see all agents
- Exception: Agents with no team assignment are visible to all users

**For MCP Servers:**

- Users can only access MCP servers assigned to teams they belong to
- Exception: Users with \`mcpServerInstallation:admin\` permission can access all MCP servers
- Exception: MCP servers with no team assignment are accessible to all users

**Associated Artifacts:**

Team-based access extends to related resources like interaction logs, policies, and tool assignments. Members can only view these artifacts for agents and MCP servers they have access to.

### Regular Review

Periodically review custom roles and team membership assignments to ensure they align with current needs and security requirements.

### Role Naming

Use clear, descriptive names for custom roles that indicate their purpose (e.g., "Agent-Manager", "Read-Only-Analyst", "Tool-Developer").
`;
}

/**
 * Extract the body content from a markdown file (everything after the frontmatter closing ---).
 */
function extractBodyFromMarkdown(content: string): string {
  // Find the closing --- of frontmatter
  const frontmatterEnd = content.indexOf("---", 4); // Skip the opening ---
  if (frontmatterEnd === -1) return content;
  return content.slice(frontmatterEnd + 3).trim();
}

/**
 * Extract the lastUpdated value from existing frontmatter.
 */
function extractLastUpdatedFromMarkdown(content: string): string | null {
  const match = content.match(/lastUpdated:\s*(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function generateMarkdownContent(existingContent: string | null): string {
  const newBody = generateMarkdownBody();

  // Determine the lastUpdated date
  let lastUpdated: string;

  if (existingContent) {
    const existingBody = extractBodyFromMarkdown(existingContent);
    const existingLastUpdated = extractLastUpdatedFromMarkdown(existingContent);

    // Only update the date if the actual content changed
    if (existingBody === newBody.trim() && existingLastUpdated) {
      // Content unchanged, keep the existing date
      lastUpdated = existingLastUpdated;
    } else {
      // Content changed, use today's date
      lastUpdated = new Date().toISOString().split("T")[0];
    }
  } else {
    // New file, use today's date
    lastUpdated = new Date().toISOString().split("T")[0];
  }

  return `${generateFrontmatter(lastUpdated)}${newBody}`;
}

async function main() {
  logger.info("📄 Generating access control documentation...");

  const docsFilePath = path.join(
    __dirname,
    "../../../../docs/pages/platform-access-control.md",
  );

  // Ensure directory exists
  const docsDir = path.dirname(docsFilePath);
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  // Read existing content if file exists (to preserve lastUpdated if content unchanged)
  let existingContent: string | null = null;
  if (fs.existsSync(docsFilePath)) {
    existingContent = fs.readFileSync(docsFilePath, "utf-8");
  }

  const markdownContent = generateMarkdownContent(existingContent);

  // Write the generated content
  fs.writeFileSync(docsFilePath, markdownContent);

  logger.info(`🙉 Documentation generated at: ${docsFilePath}`);
  logger.info("📊 Generated tables for:");
  logger.info(
    `   - ${Object.keys(predefinedPermissionsMap).length} predefined roles`,
  );
  logger.info(
    `   - ${Object.keys(allAvailableActions).reduce((sum, resource) => sum + allAvailableActions[resource as Resource].length, 0)} total permissions`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    logger.error("❌ Error generating documentation:", error);
    logger.error({ error }, "Full error details:");
    process.exit(1);
  });
}
