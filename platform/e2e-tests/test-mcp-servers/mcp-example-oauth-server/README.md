# MCP Example OAuth Server

Docker image for the [official MCP example remote server](https://github.com/modelcontextprotocol/example-remote-server) with built-in OAuth 2.1 support. Used in e2e tests to validate OAuth flows for both remote and self-hosted MCP servers.

## What it provides

- `/.well-known/oauth-authorization-server` — OAuth 2.1 discovery
- `/register` — Dynamic client registration (RFC 7591)
- `/authorize` — Authorization endpoint (with built-in mock upstream IdP)
- `/token` — Token exchange endpoint
- `/mcp` — MCP endpoint (requires Bearer token)

## Build & push

```bash
# Build locally (current arch)
make build-local

# Build and push multi-arch to GAR
make push
```

## Usage in Helm (e2e-tests)

The image is deployed as part of the `helm/e2e-tests` chart. See `values.yaml` for configuration:

```yaml
mcpExampleOAuth:
  enabled: true
```

## Running locally

```bash
docker run -p 3232:3232 mcp-example-oauth-server:0.0.1
```

Then test:

```bash
curl http://localhost:3232/.well-known/oauth-authorization-server
```
