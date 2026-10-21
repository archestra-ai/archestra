---
title: Salesforce
description: Connect Salesforce documents to Knowledge and configure source access
order: 14
lastUpdated: 2026-10-21
---

Let agents answer from your Salesforce records: "What did we promise Acme at renewal?" finds the account and its notes.

**Indexed:** CRM records from a Salesforce org. By default the connector syncs `Account`, `Contact`, `Opportunity`, and `Case`. You can list other object API names in the **Objects** field, or use **Advanced Object Config JSON** to pick exact fields and associations per object.

## Set Up Salesforce OAuth

The connector runs as the execution user of a Salesforce External Client App, using the [OAuth client credentials flow](https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_client_credentials_flow.htm&language=en_US&type=5).

1. In Salesforce **Setup**, create an **External Client App** with OAuth enabled and the **Manage user data via APIs (api)** scope.
2. [Enable client credentials flow](https://help.salesforce.com/s/articleView?id=xcloud.configure_client_credentials_flow_for_external_client_apps.htm&language=en_US&type=5). In the app's policies, enable the flow and set its execution user to a dedicated integration user with **API Enabled** and read access to your objects and fields.
3. Copy the app's consumer key and consumer secret. Copy the org's **My Domain** URL, such as `https://example.my.salesforce.com`, or `https://example--test.sandbox.my.salesforce.com` for a sandbox.

Access tokens inherit the execution user's permissions. Keep the consumer secret private and rotate it through the app and connector together. The connector obtains a new token when a session expires; this flow does not issue refresh tokens.

## Migrate an Existing Connector

Password and security-token authentication requires replacement: Salesforce [retires SOAP login in Summer ’27](https://help.salesforce.com/s/articleView?id=005132110&language=en_US&type=1).

1. Set up the External Client App above, using the same integration user and org to preserve the source's access.
2. Edit the Salesforce connector. Replace **My Domain URL**, enter **Consumer Key**, and enter a new **Consumer Secret**. A stored password cannot be reused or converted automatically.
3. Save, then use **Test Connection** and run a document sync. Saving configuration starts a full resync; object selection, assignments, and schedules remain configured.

Until migrated, connection tests and syncs report that OAuth migration is required. There is no fallback to password login.

## Connecting Salesforce

Connect an OAuth app after completing the Salesforce setup above.

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Salesforce** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field                          | Description                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| My Domain URL | HTTPS My Domain origin for your org or sandbox. `login.salesforce.com` and `test.salesforce.com` do not support this flow. |
| Consumer Key | The External Client App consumer key (client ID). |
| Consumer Secret | The External Client App consumer secret, stored as a connector secret. |
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

Use a dedicated Salesforce integration user. The app’s execution user authenticates content and permission reads. Configure its profile or permission sets with:

- **API Enabled**, with the External Client App configured for client credentials flow.
- **Read** object and field permissions for every configured field and association.
- Read access to each object's owner fields and share object.
- Read access to `User`, `Group`, and `GroupMember`.
- **View All Users** for grant-holder email resolution.
- **View All Records** on every synced object, or **View All Data**, for complete ingestion.
- **Modify Metadata Through Metadata API Functions**, or **Modify All Data**, for organization-wide defaults.

Each object is one permission scope, decided by its organization-wide default. A public object grants every user in the Archestra organization. A private object resolves records from owners and modeled share rows. A contact inherits its parent account's audience.

Restriction rules, territory hierarchies, high-volume portal shares, object CRUD access, and field-level visibility are not modeled. Restriction rules can narrow access upstream, so do not sync restricted objects through auto-sync permissions. Private objects in large organizations resolve per record; use a longer permission-sync interval.
