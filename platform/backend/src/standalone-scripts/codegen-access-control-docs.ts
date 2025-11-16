import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  type Action,
  ADMIN_ROLE_NAME,
  allAvailableActions,
  MEMBER_ROLE_NAME,
  type PredefinedRoleName,
  predefinedPermissionsMap,
  type Resource,
} from "@shared";
import logger from "@/logging";

function getResourceDescription(resource: Resource): string {
  const descriptions: Record<Resource, string> = {
    profile: "Profiles that can use tools and interact with users",
    tool: "Individual tools that can be assigned to profiles",
    policy: "Tool invocation and trusted data policies for security",
    interaction: "Conversation history and profile interactions",
    dualLlmConfig: "Dual LLM security configuration settings",
    dualLlmResult: "Results from dual LLM security validation",
    organization: "Organization settings",
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
  };
  return descriptions[resource] || "";
}

function getRoleDescription(roleName: string): string {
  const descriptions: Record<string, string> = {
    [ADMIN_ROLE_NAME]:
      "Full administrative access to all organization resources",
    [MEMBER_ROLE_NAME]:
      "Standard user with limited access to organization resources",
  };
  return descriptions[roleName] || "";
}

function generatePredefinedRolesTable(): string {
  const roles: readonly PredefinedRoleName[] = [
    ADMIN_ROLE_NAME,
    MEMBER_ROLE_NAME,
  ];

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
      const fullDescription = `${actionDesc} ${description.toLowerCase()}`;

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
  };

  return actionDescriptions[action] || "";
}

function generateMarkdownContent(): string {
  return `---
title: "Platform Access Control"
category: Archestra Platform
description: "Role-based access control (RBAC) system for managing user permissions in Archestra"
order: 4
lastUpdated: ${new Date().toISOString().split("T")[0]}
---

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

async function main() {
  logger.info("📄 Generating access control documentation...");

  const markdownContent = generateMarkdownContent();
  const docsFilePath = path.join(
    __dirname,
    "../../../../../website/app/app/docs/content/platform-access-control.md",
  );

  // Ensure directory exists
  const docsDir = path.dirname(docsFilePath);
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

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
