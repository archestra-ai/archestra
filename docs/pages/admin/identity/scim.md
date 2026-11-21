---
title: User Provisioning from Microsoft Entra ID
description: Let Microsoft Entra ID create and deactivate Archestra users
order: 3
lastUpdated: 2026-11-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra supports user provisioning from Microsoft Entra ID over [SCIM 2.0](https://www.rfc-editor.org/rfc/rfc7644). Entra creates a user in Archestra when you assign them to the Archestra app, and deactivates the user when you unassign them. Without provisioning, a user exists only after their first Single Sign-On sign-in. With provisioning, you can add users to teams before they sign in, for example [with Terraform](#example-one-entra-group-teams-in-terraform). This is an [Enterprise feature](/pricing).

## User Lifecycle

How Archestra handles each change from Entra:

- **Assigned in Entra:** Archestra creates the user with the status **Pending (auto-provisioned)** and the **Default Roles for New Users** from **Settings → Auth**.
- **First sign-in:** Single Sign-On signs the person in as the provisioned user, with any roles and teams assigned to it.
- **Unassigned in Entra:** Archestra deactivates the user, and **Settings → Users** shows them as **Deactivated**. They can't sign in, and their API keys, gateway tokens, and chat integrations stop working. Their chats, agents, and team memberships are kept. Assigning them in Entra again reactivates the user.

Archestra never deletes a user through SCIM. To delete a user, use **Remove user** in **Settings → Users**. Deactivated users are excluded from the 30-user free tier count.

## Set Up Microsoft Entra ID

Provisioning is configured on the same Entra enterprise application that handles Single Sign-On. Prerequisites:

- [Single Sign-On](/docs/admin/identity/sso) with Entra is configured.
- The Entra provider in **Settings → Identity Providers** lists every sign-in email domain in **Allowed Email Domains**. Without it, the first sign-in of a provisioned user fails with **Account Not Linked**.
- Archestra is reachable from Entra over HTTPS.

Steps:

1. In Archestra, go to **Settings → Service Accounts** and create a service account with a role that holds [`member:read`](/docs/reference/permissions#member:read), [`member:create`](/docs/reference/permissions#member:create), [`member:update`](/docs/reference/permissions#member:update), and [`member:delete`](/docs/reference/permissions#member:delete), for example the predefined **User Writer**. Create a key and copy it.
2. In the Microsoft Entra admin center, go to **Enterprise applications**, open the Archestra app, and open **Provisioning**. Set **Provisioning Mode** to **Automatic**.
3. Under **Admin Credentials**, set **Tenant URL** to `https://<your Archestra address>/api/scim/v2` and **Secret Token** to the service account key from step 1. Click **Test Connection**.
4. Under **Mappings**, disable **Provision Microsoft Entra ID Groups**. Archestra accepts only users over SCIM. This setting applies only to provisioning for this app. Groups in Entra, other apps, and the group claims in the sign-in token are unchanged, so [Team Sync](/docs/admin/identity/sso#team-sync) is unaffected.
5. Under **Settings**, set **Scope** to **Sync only assigned users and groups**.
6. Under **Users and groups**, assign the users or groups to provision.
7. Set **Provisioning Status** to **On**.

Entra runs an initial cycle for all assigned users, then incremental cycles about every 40 minutes. To provision one user immediately, use **Provision on demand** and check **Settings → Users**.

## Example: One Entra Group, Teams in Terraform

All users get access through one Entra group, and team membership is managed in Terraform.

1. In Entra, assign one group, for example **Archestra Users**, to the Archestra app.
2. Add a role that holds [`team:create`](/docs/reference/permissions#team:create) and [`team:update`](/docs/reference/permissions#team:update), for example the predefined **Team Writer**, to the service account you created for Entra in [Set Up Microsoft Entra ID](#set-up-microsoft-entra-id). Configure the Terraform provider with `ARCHESTRA_BASE_URL` and the service account key in `ARCHESTRA_API_KEY`.
3. Resolve user IDs by email with the `archestra_user` data source, and set the team's `members`:

   ```hcl
   locals {
     engineering_team = ["alice@example.com", "bob@example.com"]
   }

   data "archestra_user" "engineering_team" {
     for_each = toset(local.engineering_team)
     email    = each.value
   }

   resource "archestra_team" "engineering_team" {
     name    = "Engineering Team"
     members = [for user in data.archestra_user.engineering_team : { user_id = user.id }]
   }
   ```

4. Run `terraform apply`. The users are members of **Engineering Team** before their first sign-in.

Keep one source of truth for a team's members. Don't set `external_group_ids` on a team whose `members` Terraform manages: `terraform apply` removes anyone [Team Sync](/docs/admin/identity/sso#team-sync) added, and their next sign-in adds them back.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| A user signs in without the roles or teams assigned before sign-in | The SCIM `userName` differs from the sign-in email, so the sign-in created a separate user. | Map `userName` to the sign-in email in Entra, delete the duplicate user in **Settings → Users**, and run **Provision on demand** for the user. |
| **Account Not Linked** on first sign-in | The user's email domain is not in **Allowed Email Domains**. | Add the domain to the Entra provider in **Settings → Identity Providers**. |
| **Account Deactivated** on sign-in | The user is unassigned from the app in Entra. | Assign the user again. |
| **Test Connection** fails | Wrong tenant URL, inactive key, or missing permissions. | Check that **Tenant URL** ends in `/api/scim/v2`, the key is active, and the service account holds the `member` permissions. |
