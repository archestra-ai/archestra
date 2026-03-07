import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ADMIN_ROLE_NAME,
  internalResources,
  type PredefinedRoleName,
  type Resource,
  resourceLabels,
  roleDescriptions,
} from "@shared";
import {
  allAvailableActions,
  permissionDescriptions,
  predefinedPermissionsMap,
} from "@shared/access-control";
import logger from "@/logging";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function generatePredefinedRolesSections(): string {
  const roles = Object.keys(predefinedPermissionsMap) as PredefinedRoleName[];
  const sections: string[] = [];

  for (const role of roles) {
    const permissions = predefinedPermissionsMap[role];
    const capitalizedName = role.charAt(0).toUpperCase() + role.slice(1);

    let section = `### ${capitalizedName}\n\n`;
    section += `${roleDescriptions[role]}\n\n`;

    if (role === ADMIN_ROLE_NAME) {
      section += "The admin role has **all permissions** on every resource.\n";
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
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

Archestra uses a role-based access control (RBAC) system to manage user permissions. This system provides both predefined roles for common use cases and the flexibility to create custom roles with specific permission combinations.

Permissions in Archestra are defined using a \`resource:action\` format, where:

- **Resource**: The type of object or feature being accessed (e.g., \`agent\`, \`mcpGateway\`, \`llmProxy\`)
- **Action**: The operation being performed (\`create\`, \`read\`, \`update\`, \`delete\`, \`admin\`)

For example, the permission \`agent:create\` allows creating new agents, \`mcpGateway:update\` allows updating MCP gateways, whereas \`llmProxy:read\` would allow reading LLM proxies.

## Predefined Roles

The following roles are built into Archestra and cannot be modified or deleted:

${generatePredefinedRolesSections()}

## Custom Roles

Users with \`ac:create\` permission can create custom roles by selecting specific permission combinations. Custom roles allow fine-grained access control tailored to your needs. Note that you can only grant permissions that you already possess — this prevents privilege escalation.

### Available Permissions

The following table lists all available permissions that can be assigned to custom roles:

${generateCustomRolesPermissionsTable()}

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
- Exception: Users with \`mcpServer:admin\` permission can access all MCP servers
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
