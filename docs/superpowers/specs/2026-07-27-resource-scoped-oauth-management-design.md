# Resource-Scoped Credential Management

## Intent

Manage credentials on the resources where they apply. Remove the separate Client Credentials area after its capabilities are available from those resources.

## Decisions

- LLM Proxies, MCP Gateways, and Agents provide full management for their applicable OAuth clients.
- LLM Proxies provide full management for virtual keys and passthrough keys.
- Resource credential management lives in each resource's Connect dialog.
- The OAuth section appears at the bottom of the Agent Connect dialog.
- Credential terminology and descriptions are consistent across resource dialogs.
- Virtual keys and passthrough keys have separate tabs in the LLM Proxy Connect dialog.
- The Virtual keys tab explains that each virtual key maps provider keys and that Model Router selects from those mappings.
- Each tab creates its own key type. The creation dialog does not show another key-type selector.
- Remove Client Credentials from navigation and remove its standalone pages.
- The removed Client Credentials URLs do not redirect.
