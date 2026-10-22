---
title: Networking
description: Configure public endpoints, streaming, and workload network isolation
order: 2
lastUpdated: 2026-10-22
---

Give users and clients an HTTPS endpoint, then configure the routes and public URLs to match it.

## Public URLs and Ingress

1. Configure DNS and TLS for your Archestra host.
2. Set [`ARCHESTRA_FRONTEND_URL`](/docs/admin/deployment/configuration#ARCHESTRA_FRONTEND_URL) to the public UI URL and [`ARCHESTRA_API_BASE_URL`](/docs/admin/deployment/configuration#ARCHESTRA_API_BASE_URL) to every public backend or gateway URL. API base URLs accept a comma-separated list. Use `https://` even when TLS terminates at a load balancer.
3. Route `/v1` and `/v2` to backend port **9000**, and `/` to frontend port **3000**. Keep `/api/auth` on the frontend.
4. [Connect a client](/docs/get-started/connect) through the public endpoint and test a streaming model request and an MCP tool call.

The chart applies this split for `archestra.ingress.hosts`. A complete `archestra.ingress.spec` or external routing layer must apply it explicitly.

Gateway OAuth discovery uses the configured public URLs. An unconfigured host falls back to the request scheme, which can advertise HTTP behind a TLS-terminating proxy. [`ARCHESTRA_TRUST_PROXY`](/docs/admin/deployment/configuration#ARCHESTRA_TRUST_PROXY) does not change that rule.

## Streaming Timeouts

Set the ingress response timeout long enough for model responses. If your load balancer's backend idle-connection timeout exceeds Archestra's keep-alive timeout, raise [`ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS`](/docs/admin/deployment/configuration#ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS) above it.

## MCP Apps Sandbox

Production apps that need persistent browser storage require a sandbox domain. Without one, apps use an opaque iframe origin.

1. Choose a domain such as `mcp.example.com`.
2. Create wildcard DNS and TLS for `*.mcp.example.com`.
3. Route that wildcard host to backend port 9000.
4. Set [`ARCHESTRA_MCP_SANDBOX_DOMAIN=mcp.example.com`](/docs/admin/deployment/configuration#ARCHESTRA_MCP_SANDBOX_DOMAIN).
5. Open an app and confirm it renders through its sandbox host.

Allowed embedding origins follow [`ARCHESTRA_FRONTEND_URL`](/docs/admin/deployment/configuration#ARCHESTRA_FRONTEND_URL) and [`ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS`](/docs/admin/deployment/configuration#ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS). Local instances use `localhost` and `127.0.0.1` without a sandbox domain.

## Enforce Workload Egress

[Environment policies](/docs/admin/environments#network-egress-policies) require a network dataplane that enforces them. Creating policy objects alone does not isolate workloads.

Domain rules need an FQDN policy provider; plain Kubernetes `NetworkPolicy` supports IP/CIDR rules only.

| Cluster | IP/CIDR enforcement | Domain enforcement |
| --- | --- | --- |
| EKS Auto Mode | Kubernetes NetworkPolicy, when enabled | AWS ApplicationNetworkPolicy with the Auto Mode Network Policy Controller. DNS rules apply to Auto Mode EC2 workloads. |
| EKS with AWS VPC CNI | Kubernetes NetworkPolicy, when enabled | Not supported outside Auto Mode DNS policies. |
| AKS | Kubernetes NetworkPolicy, when enabled | CiliumNetworkPolicy when its CRD is available. |
| GKE | Kubernetes NetworkPolicy, when enabled | FQDNNetworkPolicy with Dataplane V2 and FQDN policy enabled. |
| Cilium clusters | Kubernetes or Cilium policy | CiliumNetworkPolicy. |

Check your provider's setup: [Kubernetes](https://kubernetes.io/docs/concepts/services-networking/network-policies/), [Cilium](https://docs.cilium.io/en/latest/security/dns/), [GKE](https://cloud.google.com/kubernetes-engine/docs/how-to/fqdn-network-policies), or [EKS Auto Mode](https://docs.aws.amazon.com/eks/latest/userguide/auto-net-pol.html). Archestra adds the cluster-DNS bootstrap rule required by Auto Mode policies.

Public internet mode blocks private, metadata, loopback, and reserved destinations. Add only the private ranges a workload needs under **Additional allowed CIDRs**, or use an allowlist to restrict all outbound access. DNS to the cluster resolver remains allowed.

## Code Sandbox Requirements

Managed Dagger engines need Linux nodes that allow privileged root pods with all Linux capabilities and dynamically provisioned `ReadWriteOnce` storage. These engines run separately from managed agent containers.

If your cluster cannot admit them, configure an external engine with [`ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST`](/docs/admin/deployment/configuration#ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST), or disable the sandbox with [`ARCHESTRA_CODE_RUNTIME_ENABLED=false`](/docs/admin/deployment/configuration#ARCHESTRA_CODE_RUNTIME_ENABLED) or `archestra.codeRuntime.enabled: false` in Helm.
