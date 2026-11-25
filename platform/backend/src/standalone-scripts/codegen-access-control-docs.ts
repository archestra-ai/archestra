// Binds the ports of the layers below before any other module loads.
import "@/server/composition";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ADMIN_ROLE_NAME,
  internalResources,
  PLATFORM_ADMIN_ROLE_NAME,
  type PredefinedRoleName,
  type Resource,
  resourceCategories,
  resourceLabels,
  roleDescriptions,
} from "@archestra/shared";
import {
  allAvailableActions,
  permissionDescriptions,
  predefinedPermissionsMap,
} from "@archestra/shared/access-control";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { fixedRoleGroups } from "@archestra/shared/fixed-roles";
// SPDX-SnippetEnd
import logger from "@/logging";
import { assertPortsBound } from "@/models/ports";

/**
 * The pointer every docs page carries under its frontmatter. Generated pages
 * carry it too: CI checks that codegen reproduces the committed pages exactly.
 */
const DOCS_WRITER_SKILL_COMMENT =
  "<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->";

// The composition module, imported first, bound the ports of the layers
// below; stop here if one is unbound.
assertPortsBound();

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
        "`guardrailsLog:admin`, `clientConnection:admin`, `auditLog:admin`, " +
        "and `member:impersonate`. It manages users, roles, settings, and " +
        "resources, but sees only its own logs, Guardrails records, client " +
        "connections, and audit records and cannot sign in as another member. " +
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

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
function generateFixedRolesTable(): string {
  let table = "| Group | Role | Identifier | Permissions |\n";
  table += "|-------|------|------------|-------------|\n";
  for (const group of fixedRoleGroups) {
    for (const role of group.roles) {
      const permissions = Object.entries(role.permission)
        .flatMap(([resource, actions]) =>
          (actions ?? []).map((action) => `\`${resource}:${action}\``),
        )
        .join(", ");
      table += `| ${group.name} | ${role.name} | \`${role.role}\` | ${permissions} |\n`;
    }
  }
  return table;
}
// SPDX-SnippetEnd

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

/**
 * One table per area, in the order and grouping the roles pages use
 * (`resourceCategories`), so a reader finds related permissions together.
 */
function generateCustomRolesPermissionsTable(): string {
  validatePermissionDescriptions();

  const uncategorized = (Object.keys(allAvailableActions) as Resource[]).filter(
    (resource) =>
      !internalResources.includes(resource) &&
      !Object.values(resourceCategories).some((resources) =>
        resources.includes(resource),
      ),
  );
  if (uncategorized.length > 0) {
    throw new Error(
      `Resources missing from resourceCategories: ${uncategorized.join(", ")}. ` +
        "Add them to resourceCategories in shared/permission.types.ts",
    );
  }

  return Object.entries(resourceCategories)
    .map(([category, resources]) => {
      let table = `### ${category}\n\n`;
      table += "| Permission | Description |\n";
      table += "|------------|-------------|\n";
      for (const resource of resources) {
        for (const action of allAvailableActions[resource]) {
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
    })
    .join("\n");
}

/**
 * Generate the frontmatter for the markdown file.
 */
function generateFrontmatter(): string {
  return `---
title: "Permissions"
description: "What each built-in role can do, and every permission a custom role can hold"
order: 2
---`;
}

/**
 * Generate the markdown body content (everything after frontmatter).
 */
function generateMarkdownBody(): string {
  return `

${DOCS_WRITER_SKILL_COMMENT}

<!--
GENERATED FILE — edit codegen-access-control-docs.ts, not this page.
Run \`pnpm codegen:access-control-docs\` to regenerate.
-->

Every permission is a \`resource:action\` pair, such as \`agent:create\`. A role is a set of these permissions. Docs pages link here by permission name. [Access Control](/docs/admin/access-control) explains how roles and per-item grants work together.

## Predefined Roles

Every organization has these four roles. You cannot edit or delete them.

${generatePredefinedRolesSections()}

## Granular Roles

Each granular role grants one slice of the permissions below, so you can give a user, team, or service account exactly the access it needs without writing a custom role. Assign as many as you like; their permissions add up. You cannot edit or delete them.

${generateFixedRolesTable()}
<span id="llm-api-permissions"></span>

## Available Permissions

A [custom role](/docs/admin/access-control#custom-roles) can hold any of these permissions. To grant an action on a single item, such as one agent, see [Granular Access Control](/docs/admin/access-control#granular-access-control).

${generateCustomRolesPermissionsTable()}
`;
}

function generateMarkdownContent(): string {
  return `${generateFrontmatter()}${generateMarkdownBody()}`;
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

  const markdownContent = generateMarkdownContent();

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
