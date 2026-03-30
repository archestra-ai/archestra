# MCP Server JWKS Keycloak Demo

This directory contains the source for the protected JWKS demo MCP server used in local and CI e2e environments.

It validates bearer tokens against Keycloak JWKS and exposes a small tool set for verifying per-user enterprise-managed credential exchange:

- `whoami`
- `get-server-info`
- `query-database`

Build and publish the image used by Helm:

```bash
cd platform/e2e-tests/test-mcp-servers/mcp-server-jwks-keycloak
make publish
```

The deployed e2e Helm chart references the published image configured in [values.yaml](../../../helm/e2e-tests/values.yaml).
If you change this server and want the Helm deployment to pick it up, rebuild and publish the image, then update the tag in `helm/e2e-tests/values.yaml`.
