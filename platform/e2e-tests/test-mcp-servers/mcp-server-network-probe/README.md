# MCP Server Network Probe

Tiny stdio MCP server used to test Kubernetes egress controls. It exposes one tool, `fetch_url`, which fetches an absolute URL and returns either an `OK <status>` response prefix or an `ERROR <name> <message>` network failure.

Published image:

```text
europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-network-probe:0.0.1
```

## Build and publish

```bash
cd platform/e2e-tests/test-mcp-servers/mcp-server-network-probe
make build-local
make push
```

Override `IMAGE` or `PLATFORM` when publishing a new tag:

```bash
make push IMAGE=europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-network-probe:0.0.2
```

## Archestra catalog local config

```json
{
  "dockerImage": "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-network-probe:0.0.1",
  "transportType": "stdio"
}
```

## Manual network policy checks

1. Create a network policy with restricted egress and no allowed CIDRs/domains. `fetch_url` should fail for public URLs.
2. Create a network policy with restricted egress and an allowed domain such as `httpbin.org` on a cluster with a supported FQDN policy provider. `fetch_url` should reach `https://httpbin.org/get` and fail for unrelated domains such as `https://example.com`.
3. For Kubernetes `NetworkPolicy` only clusters, use allowed CIDRs instead of domains.
