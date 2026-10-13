---
title: Perforce (Helix Core)
description: Connect Perforce (Helix Core) documents to Knowledge and configure source access
order: 16
lastUpdated: 2026-10-05
---

Let agents answer from the text files in your Perforce Helix Core depots, such as design notes and configs next to the code.

**Indexed:** files matching the configured extensions (defaults to `.md`, `.yaml`, `.yml`) under the configured depot paths, at their latest submitted revision. Files with non-text Perforce filetypes (binary, symlink, etc.) and files larger than 2 MB are skipped regardless of the extension list, so broadening the extensions (e.g. adding `.txt`, `.json`, or `.xml`) is safe even in depots that mix documentation with binary assets. Optional exclude paths carve subtrees (e.g. generated or vendored directories) out of the synced depot paths.

**Authentication:** a Perforce username with a login ticket, sent as HTTP basic authentication. The ticket must be valid for all hosts — generate it with `p4 login -a -p`. For long-lived access, use a service account whose group has an unlimited ticket timeout. The account needs read access to the configured depot paths.

The connector talks to the [P4 REST API](https://help.perforce.com/helix-core/server-apps/p4sag/current/Content/P4SAG/p4-rest-api.html), served by the built-in P4 web server. An administrator must start the web server on the P4 Server (`p4 webserver start -p <port>`; it serves HTTPS automatically when the server has an SSL certificate configured). Use a P4 Server release with the REST API available. Content sync requires no local Perforce client or workspace. For servers with self-signed certificates, provide the CA to the backend via standard Node.js trust configuration (`NODE_EXTRA_CA_CERTS`).

Incremental syncs are driven by submitted changelist numbers: after the initial sync, only files changed since the last synced changelist are re-indexed. File deletions are not propagated on incremental syncs; use **Force re-sync** to rebuild the index after large depot restructurings.

Each depot path and extension combination is listed in its own REST API request. On very large depots, server `maxresults` limits or per-request response bounds can reject a listing; configure narrower depot paths if the initial sync fails while listing files.

## Connecting Perforce

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Perforce** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field         | Description                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Server URL    | Base URL of the P4 REST API served by the P4 web server (e.g., `https://perforce.example.com:8080`)    |
| Depot Paths   | Comma-separated depot paths to sync recursively, in depot syntax (e.g., `//depot/docs`)                |
| Username      | The Perforce user (P4USER) the connector authenticates as                                               |
| Login Ticket  | An all-hosts ticket from `p4 login -a -p`                                                               |
| File Types    | Comma-separated file extensions to index (defaults to `.md`, `.yaml`, `.yml`)                           |
| Exclude Paths | Optional comma-separated depot paths skipped within the synced paths (e.g., `//depot/docs/generated`)  |

## Perforce Auto-Sync Permissions

Use two dedicated Perforce identities:

1. Give the content user `read` access to every configured depot path. Generate its all-host ticket with `p4 login -a -p`.
2. Give the permission user `admin` access with `dm.protects.allow.admin=1`, or `super` access, plus a password. This identity runs `p4 protects -a`, reads groups, and reads every user spec.
3. Populate each Perforce user's `Email` field. Missing emails require [manual assignment](/docs/knowledge/connectors#credentials-and-email-resolution).

Auto-sync permissions requires the Kubernetes orchestrator because it runs the Perforce CLI in a dedicated pod. For air-gapped deployments, configure an internal binary source under [Perforce permission-sync configuration](/docs/reference/configuration#perforce).

Choosing the auto-sync-permissions visibility adds three fields to the form:

| Field              | Description                                                                       |
| ------------------ | --------------------------------------------------------------------------------- |
| Admin Username     | The Perforce user permission sync authenticates as                                |
| Admin Password     | That account's password                                                            |
| P4 Port            | Wire-protocol address of the server, when that is not the Server URL's host        |

Leave P4 Port empty on a normal server. The P4 web server runs inside the Perforce server, so Archestra dials the Server URL's host on port 1666 and works out the transport by trying plain and SSL. Fill the field in only when something else serves the REST API — an ingress in front of the web server, for example.

Test Connection checks the whole path. It reaches the server over the wire address, signs the admin user in, and reads the protections table, so a wrong address or an under-privileged account shows up here rather than at the first permission sync.

A document's audience is the set of users whose effective read access to its depot path the protections table grants, walked with the exclusion lines honored. Access is evaluated as from an unnamed host, so host-restricted lines don't participate. Audiences are always individual users — granting through a group still resolves to its members, because an exclusion line can carve a member out of a granted group.
