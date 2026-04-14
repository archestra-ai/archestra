# MCP Server ID-JAG Demo

This directory contains the source for a protected MCP server used by e2e tests to validate the ID-JAG flow.

It demonstrates the pattern where the MCP server's authorization server accepts an ID-JAG assertion at `/token`, validates it, and mints an MCP-server-specific bearer access token. The MCP endpoint then accepts only that minted access token, not the original Archestra MCP Gateway token.

## Endpoints

- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `POST /token`
- `POST /mcp`
- `POST /demo-idp/mint`
- `GET /demo-idp/jwks`

## Build and publish

```bash
cd platform/e2e-tests/test-mcp-servers/mcp-server-id-jag
make publish
```

The e2e Helm chart references the image configured in `helm/e2e-tests/values.yaml`.
