# Resource-scoped OAuth client management

## Goal

Remove the standalone Client Credentials area without losing any OAuth client or virtual-key management capability. Credentials will be managed where they are used: in the Connect dialogs for Agents, MCP Gateways, and LLM Proxies.

## User experience

- LLM Proxy Connect dialogs retain their existing virtual-key and OAuth client management.
- MCP Gateway Connect dialogs gain an OAuth clients authentication tab.
- Agent Connect dialogs gain an OAuth clients authentication option alongside platform tokens.
- Every OAuth client surface supports listing applicable clients, creating a client with the current resource preselected, editing it, copying its client ID, rotating its secret, and deleting it.
- Rotated and newly created secrets are shown once in the existing credentials reveal dialog.
- Actions and data remain gated by the existing OAuth client read, create, update, and delete permissions.
- Empty, loading, and failed-query states are handled within each resource dialog.

## Resource scoping

MCP OAuth clients are shared by Agents and MCP Gateways. A resource dialog shows clients whose allowed gateway/agent IDs include the current resource, plus any grant type whose existing backend semantics make it generally applicable. LLM OAuth clients are filtered using their allowed LLM proxy IDs and existing grant-type semantics.

Creation defaults to the current resource type and preselects the current resource. Editing continues to use the existing OAuth client edit forms so users can change all supported fields and resource assignments.

## Component structure

Reusable OAuth creation, edit, credential-reveal, table, and row-action components will live outside the route being removed. Agent and MCP Gateway dialogs share the MCP OAuth management implementation. The existing LLM implementation adopts the same shared row-action behavior where practical, without forcing MCP- and LLM-specific fields into one overly generic model.

## Removal

Delete the `/credentials`, `/credentials/virtual-keys`, and `/credentials/oauth-clients` route files, the Client Credentials sidebar and command-palette entries, and links or copy that direct users to those pages. The old URLs intentionally return 404 rather than redirecting.

The LLM Proxy dialog must no longer truncate credential management behind a “more” link to the removed page; all relevant credentials remain reachable in the resource dialog.

## Backend and data model

No backend, database, or API contract changes are expected. The feature reuses the existing OAuth client and virtual-key queries and mutations.

## Validation

- Add or update focused component tests for resource filtering and the create/edit/rotate/delete flows in Agent and MCP Gateway dialogs.
- Update navigation tests to confirm Client Credentials is absent.
- Run focused frontend tests, frontend type checking, and linting for touched files.
- Audit product documentation for links or instructions that refer to the standalone Client Credentials pages and update any affected pages separately under the repository’s documentation conventions.
