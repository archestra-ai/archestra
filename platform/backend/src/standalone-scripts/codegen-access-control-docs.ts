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
        "`auditLog:admin`, `openappaDiagnostics:admin`, and `member:impersonate` — so holders run the " +
        "platform (users, roles, settings, resources) while other members' " +
        "LLM/MCP logs, the org-wide audit trail, and impersonation stay out " +
        "of reach. They keep `log:read` and `auditLog:read`, which show " +
        "**their own** records only. Combined with the " +
        "[no-privilege-escalation rule](/docs/admin/access-control#no-privilege-escalation), a " +
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
      // The span anchors the row, so docs can link to `/docs/reference/permissions#agent:read`.
      table += `| <span id="${key}"></span>\`${key}\` | ${permissionDescriptions[key]} |\n`;
    }
  }

  return table;
}

function generateLlmApiPermissionsSection(): string {
  return `## LLM API Permissions

| API data | Required permissions | Visibility |
|----------|----------------------|------------|
| View LLM Proxy configuration | \`llmProxy:read\` | The active organization's proxy and connection details |
| Update LLM Proxy configuration | \`llmProxy:update\` | The active organization's proxy configuration |
| Personal usage (\`/api/statistics/me*\`) | None | The caller's usage |
| Cost totals, teams, agents, models, and savings | \`llmCost:read\` | All matching usage in the active organization |
| User cost statistics (\`/api/statistics/users\`) | \`llmCost:read\` | The caller's usage |
| User cost statistics for all users | \`llmCost:read\` and \`member:read\` | Identified users in the active organization |
| App cost statistics | \`llmCost:read\` and \`app:read\` | Apps allowed by the caller’s read grants |
| Skill cost statistics | \`llmCost:read\` and \`skill:read\` | Skills allowed by the caller’s read grants |
| LLM and MCP logs for the caller | \`log:read\` | Records attributed to the caller |
| All LLM and MCP logs | \`log:read\` and \`log:admin\` | All records in the active organization, including unattributed traffic |

Service accounts use their assigned role for these APIs. A service account has no personal usage or caller-attributed log rows. Grant \`llmCost:read\` for organization-wide cost exports. Grant both \`log:read\` and \`log:admin\` for organization-wide log exports. Add \`member:read\` to include per-user cost statistics.
`;
}

/**
 * Generate the frontmatter for the markdown file.
 * @param lastUpdated - The date string for the lastUpdated field
 */
function generateFrontmatter(lastUpdated: string): string {
  return `---
title: "Permissions"
description: "Built-in role grants, available permissions, and LLM API access requirements"
order: 6
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
-->

Organization permissions use \`resource:action\` names. Roles combine these permissions; [Access Control](/docs/admin/access-control) explains how roles and resource grants work together.

## Predefined Roles

Built-in roles cannot be edited or deleted.

${generatePredefinedRolesSections()}

## Available Permissions

These permissions can be selected in custom roles. Per-resource actions and scopes are described under [Granular Access Control](/docs/admin/access-control#granular-access-control).

${generateCustomRolesPermissionsTable()}

${generateLlmApiPermissionsSection()}
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
    "../../../../docs/pages/reference/permissions.md",
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
  fs.writeFileSync(docsFilePath, `${markdownContent.trimEnd()}\n`);

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
