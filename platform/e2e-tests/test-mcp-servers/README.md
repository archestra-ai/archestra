This directory contains standalone MCP servers used by Archestra end-to-end tests.

- `mcp-example-oauth-server`: OAuth-focused fixture server
- `mcp-server-jwks-keycloak`: protected server used for JWT propagation and enterprise-managed credential exchange tests
- `mcp-server-id-jag`: protected server whose authorization server accepts ID-JAG assertions and mints MCP-server access tokens

These are test fixtures, not Helm chart logic, so they live under `e2e-tests/`.
