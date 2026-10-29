---
title: Access Control
description: Share resources and assign organization roles
order: 2
lastUpdated: 2026-10-22
---

Give people **Can use** on an agent to let them run it without changing it. Give them **Can update** when they need to edit it.

<span id="actions-and-scopes"></span>

<span id="agent-access-vs-mcp-server-access"></span>

<span id="api-example"></span>

<span id="available-permissions"></span>

<span id="chat-access-and-optional-ui-controls"></span>

<span id="environments"></span>

<span id="find-resources-by-access"></span>

<span id="granular-access-control"></span>

<span id="llm-api-permissions"></span>

<span id="log-visibility"></span>

<span id="mcp-registry-and-installation-records"></span>

<span id="models"></span>

<span id="oauth-clients"></span>

<span id="resource-specific-rules"></span>

<span id="saved-credentials"></span>

<span id="scoped-resources"></span>

<span id="service-account-creators"></span>

<span id="sharing-level"></span>

<span id="team-access"></span>

<span id="visibility-scoped-credentials"></span>

## Share a Resource

Resource sharing is an [Enterprise feature](/docs/get-started/pricing-model).

1. Open the item's **Permissions** control.
2. Add a person, team, role, service account, or **Everyone in the organization**.
3. Choose their level, then save.

| Level | Allows |
| --- | --- |
| Can read | View the item. |
| Can use | Run or invoke it. |
| Can update | Edit its configuration. |
| Full access | Delete it and manage access. |

You need **Manage access** on the item to share it. To share every current and future item of a kind, use **Permissions** beside **Create** or **Add** on its list; this requires [`accessPolicies:update`](/docs/reference/permissions#accessPolicies:update).

Sharing with everyone, a role, or a team you do not belong to also requires that permission or **Full access** on every item of that kind. You cannot grant access you do not hold.

Sharing an agent does not share its MCP servers. Share the servers separately so the person can use their tools. MCP registry entries have an extra **Full access + deploy** level for changing deployments and secret sources; see [server permissions](/docs/mcp/servers).

## Predefined Roles

Roles control organization actions, such as creating resources and managing users. Resource grants determine which individual items a person can use or change.

**Member** is the default. Choose a broader role only when the person needs it:

| Role | Choose it for |
| --- | --- |
| Member | Using Chat and creating agents, apps, skills, and gateways. |
| Editor | Also managing providers, models, budgets, environments, Knowledge, and Guardrails. |
| Platform Admin | Administering the platform without viewing everyone's logs or impersonating users. |
| Admin | Full organization administration, including everyone's logs and user impersonation. |

See the [exact permission matrix](/docs/reference/permissions#predefined-roles). To change a member's roles, open **Settings → Users**, choose **Change role** on their row, and save with **Update Roles**.

<span id="custom-roles"></span>

<span id="multiple-roles-and-team-grants"></span>

<span id="no-privilege-escalation"></span>

<span id="team-roles"></span>

## Create a Custom Role

1. With [`ac:create`](/docs/reference/permissions#ac:create), open **Settings → Roles** and create a role.
2. Select only the [permissions](/docs/reference/permissions#available-permissions) the job needs.
3. Assign it to a member, team, or service account.

Accounts combine their direct roles with roles from their teams and ancestor teams. A team admin manages that team's members and settings; team admin status does not pass to descendant teams.

<span id="delegation-and-concurrent-edits"></span>

<span id="inheritance-and-revocation"></span>

<span id="team-hierarchies"></span>

## Remove Access

Open the item's permissions and remove the recipient. Check inherited grants too: removing a direct grant leaves access through teams, roles, or the organization intact. Team grants reach descendant teams, but not parents or siblings.

Keep at least one recipient with **Manage access**. If a role or team change would delegate access you cannot grant, the form identifies the affected resources and missing permissions.

<span id="ownership"></span>

## Transfer Ownership

Choose **Make owner** on another person's row in the permissions editor. You need edit and full access on the item; plugins require edit access to every plugin.

The new owner receives **Full access**. The previous owner keeps their grant until you remove it separately. An owner's grant cannot be removed while they still own the resource.

For request and audit-log access, see [Logs and Auditing](/docs/admin/logs#who-can-read-them). For automated permission changes, use the [Permissions API](/docs/reference/api#/Permissions/getResourcePermissions).
