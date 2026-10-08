---
title: Salesforce
description: Connect Salesforce documents to Knowledge and configure source access
order: 14
lastUpdated: 2026-10-05
---

Let agents answer from your Salesforce records: "What did we promise Acme at renewal?" finds the account and its notes.

**Indexed:** CRM records from a Salesforce org. By default the connector syncs `Account`, `Contact`, `Opportunity`, and `Case`. You can list other object API names in the **Objects** field, or use **Advanced Object Config JSON** to pick exact fields and associations per object.

**Authentication:** a Salesforce username, password, and security token. The password field must contain the password directly concatenated with the security token (no separator). To get the token: log in to Salesforce, click your **User Avatar > Settings**, then go to **My Personal Information > Reset My Security Token** and check your email.

## Connecting Salesforce

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Salesforce** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field                          | Description                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Login URL                      | Salesforce login endpoint (default: `https://login.salesforce.com`; use `https://test.salesforce.com` for sandbox orgs) |
| Email                          | Your Salesforce username (e.g., `reader@example.com`)                                                          |
| Password + Security Token      | Your Salesforce password concatenated with your security token (e.g., `MyPassword123XXYYZZ`)                 |
| Objects                        | Comma-separated Salesforce object API names to sync (e.g., `Account, Contact, Opportunity, Case`). Leave blank for the defaults. |
| Advanced Object Config JSON    | Optional JSON for precise field and association control. Overrides the Objects field when provided.          |

Example advanced config:

```json
{
  "Lead": {
    "fields": ["FirstName", "LastName", "Company", "Email"],
    "associations": { "Account": ["Name"] }
  },
  "Case": {
    "fields": ["Subject", "Status", "Priority", "Description"]
  }
}
```

`Id`, `Name`, and `LastModifiedDate` are always included automatically.

## Salesforce Auto-Sync Permissions

Use a dedicated Salesforce integration user. The same username, password, and security token authenticate content and permission reads. Configure its profile or permission sets with:

- **API Enabled**. In **Setup > User Interface**, enable **SOAP API login()**. If SOAP login restrictions are enforced, also grant **Use Any API Auth**.
- **Read** object and field permissions for every configured field and association.
- Read access to each object's owner fields and share object.
- Read access to `User`, `Group`, and `GroupMember`.
- **View All Users** for grant-holder email resolution.
- **View All Records** on every synced object, or **View All Data**, for complete ingestion.
- **Modify Metadata Through Metadata API Functions**, or **Modify All Data**, for organization-wide defaults.

Each object is one permission scope, decided by its organization-wide default. A public object grants every user in the Archestra organization. A private object resolves records from owners and modeled share rows. A contact inherits its parent account's audience.

Restriction rules, territory hierarchies, high-volume portal shares, object CRUD access, and field-level visibility are not modeled. Restriction rules can narrow access upstream, so do not sync restricted objects through auto-sync permissions. Private objects in large organizations resolve per record; use a longer permission-sync interval.
