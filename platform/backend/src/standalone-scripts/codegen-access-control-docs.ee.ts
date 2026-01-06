import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Action, PredefinedRoleName, Resource } from "@shared";
import {
  allAvailableActions,
  predefinedPermissionsMap,
} from "@shared/access-control.ee";
import logger from "@/logging";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getResourceDescription(resource: Resource): string {
  const descriptions: Record<Resource, string> = {
    profile: "Profiles that can use tools and interact with users",
    tool: "Individual tools that can be assigned to profiles",
    policy: "Tool invocation and trusted data policies for security",
    interaction: "Conversation history and profile interactions",
    dualLlmConfig: "Dual LLM security configuration settings",
    dualLlmResult: "Results from dual LLM security validation",
    organization: "Organization settings",
    ssoProvider: "SSO providers for authentication",
    member: "Organization members and their roles",
    invitation: "Member invitations and onboarding",
    internalMcpCatalog: "Internal MCP server catalog management",
    mcpServer: "MCP servers for tool integration",
    mcpServerInstallationRequest: "Requests for new MCP server installations",
    mcpToolCall: "Tool execution logs and results",
    team: "Teams for organizing members and access control",
    conversation: "Chat conversations with automation experts",
    limit: "Usage limits and quotas",
    tokenPrice: "Token pricing configuration",
    chatSettings: "Chat feature configuration and settings",
    prompt: "Reusable prompt templates and system prompts",
    ac: "RBAC roles",
  };
  return descriptions[resource] || "";
}

// Using Record<PredefinedRoleName, string> ensures TypeScript will error
// if a new predefined role is added but description is missing
const roleDescriptions: Record<PredefinedRoleName, string> = {
  admin: "Full administrative access to all organization resources",
  editor:
    "Power user with full CRUD access to most resources but no admin privileges",
  member: "Standard user with limited access to organization resources",
};

function getRoleDescription(roleName: PredefinedRoleName): string {
  return roleDescriptions[roleName];
}

function generatePredefinedRolesTable(): string {
  // Dynamically get all predefined roles from the permissions map
  const roles = Object.keys(predefinedPermissionsMap) as PredefinedRoleName[];

  let table = "| Role | Description | Granted Permissions |\n";
  table += "|------|-------------|--------------------|\n";

  for (const role of roles) {
    const permissions = predefinedPermissionsMap[role];
    const permissionsList = Object.entries(permissions)
      .map(([resource, actions]) =>
        actions
          .map((action) => `\`${resource}:${action}\``)
          .join("<br /><br />"),
      )
      .join("<br /><br />");

    table += `| **${role}** | ${getRoleDescription(role)} | ${permissionsList} |\n`;
  }

  return table;
}

function generateCustomRolesPermissionsTable(): string {
  const resources = Object.keys(allAvailableActions) as Resource[];

  let table = "| Permission | Description |\n";
  table += "|------------|-------------|\n";

  for (const resource of resources.sort()) {
    const actions = allAvailableActions[resource];
    const description = getResourceDescription(resource);

    for (const action of actions) {
      const permission = `${resource}:${action}`;
      const actionDesc = getActionDescription(action);
      // don't lowercase "RBAC roles"
      const fullDescription = `${actionDesc} ${resource === "ac" ? description : description.toLowerCase()}`;

      table += `| \`${permission}\` | ${fullDescription} |\n`;
    }
  }

  return table;
}

function getActionDescription(action: Action): string {
  const actionDescriptions: Record<Action, string> = {
    create: "Create new",
    read: "View and list",
    update: "Modify existing",
    delete: "Remove existing",
    admin: "Administrative control over",
    cancel: "Cancel",
  };

  return actionDescriptions[action] || "";
}

/**
 * Generate the frontmatter for the markdown file.
 * @param lastUpdated - The date string for the lastUpdated field
 */
function generateFrontmatter(lastUpdated: string): string {
  return `---
title: "Platform Access Control"
category: Archestra Platform
description: "Role-based access control (RBAC) system for managing user permissions in Archestra"
order: 4
lastUpdated: ${lastUpdated}
---`;
}

/**
 * Generate the markdown body content (everything after frontmatter).
 */
function generateMarkdownBody(): string {
  return `
<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

Archestra uses a role-based access control (RBAC) system to manage user permissions within organizations. This system provides both predefined roles for common use cases and the flexibility to create custom roles with specific permission combinations.

Permissions in Archestra are defined using a \`resource:action\` format, where:

- **Resource**: The type of object or feature being accessed (e.g., \`profile\`, \`tool\`, \`organization\`)
- **Action**: The operation being performed (\`create\`, \`read\`, \`update\`, \`delete\`, \`admin\`)

For example, the permission \`profile:create\` allows creating new profiles, while \`organization:read\` allows viewing organization information.

## Predefined Roles

The following roles are built into Archestra and cannot be modified or deleted:

${generatePredefinedRolesTable()}

## Custom Roles

Organization administrators can create custom roles by selecting specific permission combinations. Custom roles allow fine-grained access control tailored to your organization's needs.

### Permission Requirements

- **Role Creation**: Only users with \`organization:update\` permission can create custom roles
- **Permission Granting**: You can only grant permissions that you already possess
- **Role Limits**: Up to 50 custom roles per organization

### Available Permissions

The following table lists all available permissions that can be assigned to custom roles:

${generateCustomRolesPermissionsTable()}

## Best Practices

### Principle of Least Privilege

Grant users only the minimum permissions necessary for their role. Start with the member role and add specific permissions as needed.

### Team-Based Organization

Combine roles with team-based access control for fine-grained resource access:

1. **Create teams** for different groups (e.g., "Data Scientists", "Developers")
2. **Assign profiles and MCP servers** to specific teams
3. **Add members to teams** based on their role and responsibilities

#### Team Access Control Rules

**For Profiles:**

- Team members can only see profiles assigned to teams they belong to
- Exception: Users with \`profile:admin\` permission can see all profiles
- Exception: Profiles with no team assignment are visible to all organization members

**For MCP Servers:**

- Team members can only access MCP servers assigned to teams they belong to
- Exception: Users with \`mcpServer:admin\` permission can access all MCP servers
- Exception: MCP servers with no team assignment are accessible to all organization members

**Associated Artifacts:**

Team-based access extends to related resources like interaction logs, policies, and tool assignments. Members can only view these artifacts for profiles and MCP servers they have access to.

### Regular Review

Periodically review custom roles and member assignments to ensure they align with current organizational needs and security requirements.

### Role Naming

Use clear, descriptive names for custom roles that indicate their purpose (e.g., "Profile-Manager", "Read-Only-Analyst", "Tool-Developer").
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
