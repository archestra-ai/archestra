# Entra OBO Debug MCP Server

Streamable HTTP MCP server used to verify enterprise-managed Entra OBO credentials.

It exposes a `debug-auth-token` tool that returns the bearer token metadata received by the MCP server, including audience, scopes or roles, tenant ID, issuer, and username claims.

## Run Locally

```bash
npm install
npm start
```

Defaults:

- HTTP endpoint: `http://localhost:3456/mcp`
- Health endpoint: `http://localhost:3456/health`

Set `PORT` or `MCP_PATH` to override those values.
