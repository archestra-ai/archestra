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
  return `## Resource Permission Grants

Agents, MCP gateways, MCP registry entries, skills, apps, and models support grants for individual resources. A grant identifies a recipient and the actions they may perform on that resource.

| Where you are | Manage permissions |
| --- | --- |
| Creating an agent, MCP registry entry, skill, or app | Add recipients in **Permissions** before saving |
| Agent, MCP gateway, MCP registry entry, or skill detail page | Open the **Permissions** tab |
| App settings | Open **Permissions** in the settings dialog |
| Models list | Choose **Permissions** from the model's actions |
| All objects of a resource type | Open **Settings > Roles > Resource grants** and select the resource type |

Initial grants are validated before creation and persisted with the resource. Invalid recipients or grants beyond your authority reject the creation. Creation APIs and their matching MCP authoring tools accept an optional \`initialGrants\` array with the same recipient/action entries used below. Models are discovered from providers, so their permissions are configured after discovery.

Resource grants are an Enterprise feature, available under the small-team allowance described in [Pricing Model](/docs/platform-pricing-model). When that entitlement ends, existing grants continue to be enforced and you can revoke or reduce them; adding or expanding grants requires an active entitlement.

Recipients can be users, teams, service accounts, roles, or everyone in the organization. A service account is an independent recipient; its grants do not depend on the person who created it. Disabled service accounts cannot use their grants. Their assigned roles and organization-wide grants also contribute to access, so removing one direct grant does not necessarily remove all access.

### Actions And Scopes

Each permission is evaluated as one complete action-and-scope pair. The scope identifies one resource, all resources, or resources shared with the recipient’s teams. A wildcard for agents does not grant access to MCP servers, and a wildcard never crosses the organization boundary.

| Scope | Applies To |
| --- | --- |
| Resource ID | One resource |
| \`*\` | Every current and future resource of that type in the organization |
| \`teams:*\` | Resources with a direct grant to one of the recipient's current teams |

Team-relative scopes follow current membership, including ancestor teams. They do not depend on team membership roles. Service accounts have no team membership, so team-relative grants do not apply to them.

| Action | Allows |
| --- | --- |
| \`read\` | View the resource |
| \`use\` | Use or execute the resource |
| \`update\` | Edit its configuration |
| \`delete\` | Delete the resource |
| \`manage-permissions\` | Change its direct grants, within the caller's own authority |

Viewing a resource does not by itself grant execution. Uncatalogued model IDs require a model \`use\` grant on \`*\`. For example, a model read grant does not bypass its invocation restrictions; use a model use grant to permit invocation. Disabled apps remain private to their author, even when another recipient has a grant. Editing configuration does not grant permission to share the resource. Creation continues to require the resource's organization-level \`create\` permission because the object does not exist yet.

For example, a service account can have \`read\` on all MCP registry entries and \`update\` on one entry. Those grants allow it to view every entry and edit only that one. The evaluator does not combine the wildcard from the first grant with the update action from the second.

The editor offers **Can view**, **Can use**, **Can edit**, and **Full access** presets. Full access includes deletion and permission management. Inspect the action list below each recipient before saving.

Public marketplace link management remains organization-wide. Creating, listing, rotating, or revoking skill marketplace links requires skill \`read\`, \`use\`, and \`manage-permissions\` on \`*\`. Editing a skill alone does not authorize public distribution. A link contains the skills selected when it is created; it does not automatically include future skills.

### Inheritance And Revocation

A recipient receives the union of its applicable grants: direct user or service-account grants, team grants, grants to its effective roles, and organization-wide grants. Team grants follow the team hierarchy described below. Grants to roles follow role composition.

The Permissions editor shows direct grants and inherited grants with their source scopes. Removing a direct grant does not remove access supplied by another grant. Change an inherited grant at its source. List views omit personal, team, and organization visibility categories. Built-in origin and labels remain separate filters.

### Migration From Visibility

The migration converts existing sharing into resource grants. Organization-wide sharing becomes an organization grant. Personal ownership becomes an explicit full-access grant. Team use shares become read and use grants. Team write shares additionally grant update. Every team member receives those actions, regardless of their membership role.

Resource-level \`:admin\` scopes become \`*\` grants with their associated actions. Resource-level \`:team-admin\` scopes become \`teams:*\` grants. These legacy scope flags are distinct from the team's membership admin role.

Existing explicit grants, including service-account grants, survive migration. Migrated policies replace legacy sharing checks. Revoking a grant cannot restore access through an old ownership or visibility setting. Other applicable grants can still provide access.

Creation with \`initialGrants\` also records the creator's full access explicitly. An empty array creates a creator-only direct policy. Inherited grants still apply. Resources outside this conversion retain the rules described under **Scoped Resources** below.

### Delegation And Concurrent Edits

To change a policy, you need \`manage-permissions\` on that scope. You can grant only actions that you also hold on that same scope. Authority over one object does not authorize a wildcard grant. Assigning a role or changing team inheritance also checks its scoped grants, including ancestor teams. Team membership administrators can add and remove their team’s members. This changes recipients of existing team grants; it does not let administrators edit those grants or resources. Other callers adding members must also hold the authority they delegate. Role assignment cannot bypass the grant-delegation check.

Saving includes the policy revision. If someone else changes the policy first, the API returns \`409\` and the editor preserves your draft. Reload the latest policy before saving again. Changes to grants are recorded in the audit log. Unsaved permission edits are kept separate from ordinary configuration saves; use **Save permissions** to apply them.

### API Example

Read a policy with \`GET /api/resource-permissions/mcpRegistry/<catalog-id>\`. Replace its direct grants with \`PUT\` to the same URL, passing the revision returned by the read:

\`\`\`json
{
  "revision": 0,
  "grants": [
    {
      "subject": {
        "type": "serviceAccount",
        "id": "00000000-0000-4000-8000-000000000001"
      },
      "actions": ["read", "use"]
    }
  ]
}
\`\`\`

Use the service account's ID, not an API-key ID. The recipient must belong to the organization and be active. \`PUT\` replaces the complete direct-grant list; include any existing direct grants you intend to retain. It does not replace inherited grants.

## Scoped Resources

Agents, MCP gateways, registry entries, apps, skills, and models use the grants described above.
Each grant pairs actions with a resource scope. Creation uses the resource's create permission.
Legacy visibility fields do not authorize access after migration.

### Team Roles

Team membership has its own role, separate from organization RBAC:

- \`member\`: belongs to the team and can access resources shared with that team
- \`admin\`: can add and remove members, rename the team, edit its description and metadata, and manage team-scoped settings such as external group sync mappings

Whoever creates a team joins it as that team's first admin, so they can manage its members straight away.

Team admins can edit their own team without organization-wide \`team:update\`. This does not let them edit other teams, create teams, or delete teams; those operations require their own authorization. A team membership admin role does not grant MCP catalog editing, installation management, or connection reauthentication. Team members receive the same resource grants regardless of their membership role.

Team administration does not grant access to resources shared with the team.
Resource access comes from grants and inherited organization roles.

### Team Hierarchies

Teams can be nested to match an organization structure. A resource assigned to a team is available to direct members of that team and members of every descendant team, at any depth. Access does not flow upward from a child to its parent or sideways to sibling teams.

Hierarchy expands resource visibility and inherits organization roles assigned to ancestor teams. Team membership roles are not inherited. Being a child team admin does not make you its parent's team admin. Deleting a parent moves its direct children to the root.

External group sync continues to create direct memberships on the mapped team. Those members receive inherited resource access from its ancestors; see [SSO Team Sync](/docs/platform-sso-team-sync).

### Agents, MCP Gateways, Apps, and Skills

Object grants control reading, execution, editing, deletion, and permission management independently.
An update grant does not include execution or permission management.
Creation adds a full grant for the creator. That grant can be revoked.
Ownership and team administration do not override revocation.

### Visibility-Scoped Credentials

\`llmProviderApiKey\` and \`llmVirtualKey\` also support \`personal\`, \`team\`, and \`org\` scope, but they use different elevated permissions:

- Personal records are limited to their owner
- Team records require membership in the selected team, with team member admins able to manage their own team
- Organization-wide records require the resource-specific admin permission such as \`llmProviderApiKey:admin\` or \`llmVirtualKey:admin\`

These resources do **not** use \`:team-admin\`.

### Models

Model read grants control discovery. Model use grants control invocation through the LLM Proxy.
Sharing a model with a team does not grant editing.
A wildcard use grant includes future models of that organization.
Provider catalog refreshes preserve existing grants and revocations.

### Chat Access And Optional UI Controls

Chat access is controlled separately from optional chat UI controls:

- \`chat:read\` allows access to chat itself
- \`agent:read\` is also required because chat is agent-backed and a user must be able to access at least one agent/profile context to start or use chat
- \`chatAgentPicker:enable\` controls whether the agent picker is visible
- \`chatProviderSettings:enable\` controls whether model and API key selectors are visible

The selector visibility permissions are UI toggles. They should be treated independently from core chat access and should not be assumed to grant access to provider credentials or model catalogs on their own.

### MCP Registry And Installation Records

Registry grants control access to the catalog entry.
Installation permissions separately control connections, credentials, and running servers.
Editing a team does not authorize installing or reauthenticating its connections.

`;
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

For example, \`agent:create\` allows creating agents, \`mcpGateway:update\` allows updating MCP gateways, and \`llmProxy:read\` allows viewing the LLM Proxy.

## Predefined Roles

The following roles are built into Archestra and cannot be modified or deleted:

${generatePredefinedRolesSections()}

## Custom Roles

Users with \`ac:create\` permission can create custom roles by selecting specific permission combinations. Custom roles allow fine-grained access control tailored to your needs.

### Multiple Roles And Team Grants

Users and service accounts can have multiple organization roles. Their permissions combine: a grant from any assigned role allows that action.

Teams can also hold organization roles. Members inherit these grants from their own teams and every ancestor in the [team hierarchy](#team-hierarchies). Removing a role or membership removes its grants, unless another assignment provides the same permissions.

The account permissions page shows each permission's sources when you hover over or focus its badge. Organization roles assigned to teams are separate from [team membership roles](#team-roles).

#### No privilege escalation

A role can only be granted by someone who already holds every permission it carries. This single rule is enforced server-side on **every** grant path:

- creating or editing a custom role's permissions,
- changing a member's role,
- inviting a user with a role,
- setting the organization's default member role,
- creating or updating a service account,
- assigning roles to teams, adding team members, or changing team parents.

The role pickers in the UI disable roles you cannot grant and explain which permissions you are missing. The rule is what makes deliberately-restricted admin roles trustworthy: an admin role created without, say, \`log:read\`, \`auditLog:read\`, and \`member:impersonate\` cannot be escaped by its holders — with \`member:update\` they can still manage users freely inside their own permission set, but any attempt to hand out (to themselves or anyone else) a role carrying the withheld permissions is rejected. Roles applied by an identity provider through [SSO role mapping](/docs/platform-sso-role-mapping) are the deliberate exception: they are granted by the IdP configuration, not by a platform user.

### Available Permissions

The following table lists all available permissions that can be assigned to custom roles:

${generateCustomRolesPermissionsTable()}

${generateLlmApiPermissionsSection()}

${generateScopedResourcesSection()}

## Team Access

Team grants apply to direct members and descendant-team members.
Every membership role receives the same resource grants.
An empty grant list does not make a resource public.
Wildcard grants remain effective when an object's direct grants are removed.

#### Agent Access vs MCP Server Access

The two team assignments gate different things. Agent access decides who can call the agent's tools. MCP server access decides who can see, install, and manage the server in the registry.

In **Custom** tool mode, sharing an agent shares its assigned tools. A user with agent access can call an assigned tool even when its MCP server is not shared with them. [Credential resolution](/docs/mcp-authentication#credential-resolution) decides whose connection serves each call: a pinned connection serves every caller, and resolve-at-call-time looks for a connection the caller can reach.

In **Auto** tool mode, each caller can only discover and run tools from MCP servers they can access themselves — plus any tools explicitly assigned to the agent. See [Tool Access Modes](/docs/platform-agents#tool-access-modes).

**Associated Artifacts:**

Policies and tool assignments follow their associated resources. LLM and MCP logs use the permissions in [LLM API Permissions](#llm-api-permissions).

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
