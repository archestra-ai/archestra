---
title: ServiceNow
description: Connect ServiceNow documents to Knowledge and configure source access
order: 6
lastUpdated: 2026-10-05
---

Let agents answer from your ServiceNow incidents, problems, and other ITSM records, so a new incident finds how the last one was solved.

**Indexed:** incidents, change requests, change tasks, problems, business applications, and published knowledge articles. Incidents are enabled by default; the rest are opt-in.

**Authentication:** the connector form uses basic auth. Create a dedicated user under **User Administration > Users**, enable **Web service access only**, and set a password. API-created connectors can instead leave Email empty and store a pre-issued OAuth bearer token in the API Token field; the connector does not refresh that token.

## Required Roles

 Use a dedicated service account ("Web service access only" is fine). The account needs roles that can read every synced table:

| Role | Grants read on |
| --- | --- |
| `itil` | Incidents, changes, change tasks, problems, and business applications |
| `knowledge` | Knowledge articles |
| `user_criteria_admin`, `user_admin` | User criteria definitions and the user, group, and role tables auto-sync reads |

The Can Read / Cannot Read criteria mappings (`kb_uc_can_read_mtom`, `kb_uc_cannot_read_mtom`) have no role-based read access out of the box — built-in roles such as `knowledge_admin` do not open them. Auto-sync permissions needs explicit access control lists (ACLs) on both tables.

Creating ACLs requires the `security_admin` role. ServiceNow grants it by elevation for the current session, and hides the **New** button on the ACL list until you elevate: open the profile menu, select **Elevate role**, and check **security_admin**. Then:

1. Go to **System Security → Access Control (ACL)** and select **New**. Set Type `record`, Operation `read`, and Name `kb_uc_can_read_mtom` with the field left as `--None--`. Under **Requires role**, add a role the service account holds. Submit.
2. Create a second ACL for the same table with the field set to `*`, which grants read on its fields.
3. Repeat both ACLs for `kb_uc_cannot_read_mtom`.

An account without the right roles fails in one of two ways, depending on the instance's ACLs: the sync errors with HTTP 403 "Insufficient rights to query records", or ServiceNow silently filters the rows and the sync succeeds with nothing ingested. Test the account directly before connecting: `curl -u '<user>:<password>' 'https://<instance>.service-now.com/api/now/table/incident?sysparm_limit=1'` should return a record, not an error and not an empty result.

## Connecting ServiceNow

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **ServiceNow** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field                         | Description                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Instance URL                  | Your ServiceNow instance URL (e.g., `https://your-instance.service-now.com`)                                                  |
| Include Incidents             | Sync incidents from the `incident` table (default: on)                                                                        |
| Include Changes               | Sync change requests from the `change_request` table (default: off)                                                           |
| Include Change Tasks          | Sync change tasks from the `change_task` table (default: off)                                                                 |
| Include Problems              | Sync problems from the `problem` table (default: off)                                                                         |
| Include Business Applications | Sync business applications from the `cmdb_ci_business_app` CMDB table (default: off)                                          |
| Include Knowledge Articles    | Sync published knowledge articles from the `kb_knowledge` table (default: off)                                                |
| Role audiences                | Per-table ServiceNow role names for auto-sync permissions — see below (optional)                                              |
| States                        | Comma-separated state values to filter by (e.g. `1, 2`). Applies to incidents, changes, change tasks, and problems (optional) |
| Assignment Groups             | Comma-separated assignment group sys_ids to filter by. Does not apply to business applications (optional)                     |

## ServiceNow Auto-Sync Permissions

ServiceNow decides record access with ACL rules, and those rules cannot be read through its REST API. For ITSM records and business applications, the connector grants each record to its participants instead: assignment group members plus the referenced users — the caller, the opener, and the assignee. Custom ACL conditions can make this audience differ from ServiceNow. To widen a table's audience, add role names under **Role audiences** (`itil`, for example) only when every holder can read every synced record in that table.

Knowledge articles follow ServiceNow's own permission model: **Can Read** and **Cannot Read** user criteria at knowledge-base and article level. The connector expands each criteria to its users, groups, roles, companies, departments, and locations. Script-based (advanced) criteria cannot be evaluated over the API: on an allow path they grant nobody; on a deny path the affected knowledge base or article is hidden from everyone. A knowledge base without criteria follows the instance's `glide.knowman.block_access_with_no_user_criteria` property — open to your whole Archestra organization when `false`, hidden when `true` or unreadable.

Required access. The connector account needs read access to these tables:

| Tables | Used for |
| --- | --- |
| `incident`, `change_request`, `change_task`, `problem`, `cmdb_ci_business_app`, `kb_knowledge` | Content sync of the enabled entities. Reading the ITSM tables needs the `itil` role on most instances |
| `sys_user`, `sys_user_group`, `sys_user_grmember`, `sys_user_has_role` | Resolving participants, group rosters, and role audiences to user emails |
| `user_criteria`, `kb_uc_can_read_mtom`, `kb_uc_cannot_read_mtom`, `sys_properties` | Knowledge-article audiences |
| `core_company`, `cmn_department`, `cmn_location` | Expanding criteria that reference them |

The [Required Roles](#required-roles) section above covers these, including the explicit ACLs the criteria mapping tables need.

Misconfiguration behaves silently. ServiceNow filters out rows an account cannot read instead of returning an error. An under-privileged account therefore looks like missing data: content sync ingests nothing from a table it cannot read, and a permission table it cannot read makes the affected audiences fail closed — the documents exist but nobody can retrieve them. Each permission sync run reports how many audiences it could not read, so check the run details when documents seem to be missing or hidden. Knowledge bases in the HR Service Delivery scope (`sn_hr_core`) additionally need the `sn_hr_core.content_reader` role; without it their criteria read as empty and the articles fail closed.
