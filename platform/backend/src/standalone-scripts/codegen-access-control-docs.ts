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

    if (role === ADMIN_ROLE_NAME) {
      section +=
        "Admin holds every permission, including user management, roles, " +
        "and organization settings.\n";
    } else if (role === PLATFORM_ADMIN_ROLE_NAME) {
      section +=
        "Platform Admin holds every permission except `log:admin`, " +
        "`auditLog:admin`, `member:impersonate`, and `sre:read`. It " +
        "manages users, roles, settings, and resources, but sees only its " +
        "own logs and audit records and cannot sign in as another member. " +
        "Because of " +
        "[No Privilege Escalation](/docs/admin/access-control#no-privilege-escalation), " +
        "it cannot grant a role that holds the withheld permissions.\n";
    } else {
      section += `${roleDescriptions[role]}.\n\n`;
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
      const legacyAnchors =
        resource === "oauthClient"
          ? ["mcpOauthClient", "llmOauthClient"]
              .map((old) => `<span id="${old}:${action}"></span>`)
              .join("")
          : resource === "project"
            ? `<span id="scheduledTask:${action}"></span>`
            : "";
      table += `| ${legacyAnchors}<span id="${key}"></span>\`${key}\` | ${permissionDescriptions[key]} |\n`;
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
title: "Permissions"
description: "What each built-in role can do, and every permission a custom role can hold"
order: 2
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

Every permission is a \`resource:action\` pair, such as \`agent:create\`. A role is a set of these permissions. Docs pages link here by permission name. [Access Control](/docs/admin/access-control) explains how roles and per-item grants work together.

## Predefined Roles

Every organization has these four roles. You cannot edit or delete them.

${generatePredefinedRolesSections()}

<span id="llm-api-permissions"></span>

## Available Permissions

A [custom role](/docs/admin/access-control#custom-roles) can hold any of these permissions. To grant an action on a single item, such as one agent, see [Granular Access Control](/docs/admin/access-control#granular-access-control).

${generateCustomRolesPermissionsTable()}
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
