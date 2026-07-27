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
- Selecting Model Router shows a compact alert that explains routing. Virtual-key guidance appears once in the Virtual keys tab.
- Authentication tabs use one short explanation beside their primary action. Passthrough guidance says that subscriptions work and that its attribution key is optional.
- Each tab creates its own key type. The creation dialog does not show another key-type selector.
- Provider-key mapping uses one grouped, searchable picker. Selecting a key adds its provider mapping immediately without a separate Add action. Each provider can have only one mapped key.
- Credential lists paginate within the resource dialog and do not link to the removed Client Credentials pages.
- Remove Client Credentials from navigation and remove its standalone pages.
- The removed Client Credentials URLs do not redirect.
