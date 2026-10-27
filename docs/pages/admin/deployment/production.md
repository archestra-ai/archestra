---
title: Production
description: Prepare database recovery, public access, and cluster capacity before serving traffic
order: 2
lastUpdated: 2026-10-27
---

Before sending production traffic through Archestra, make sure you can restore its database and keys, reach its public endpoints, and run its workloads safely.

## Releases and Backups

Test an exact release in staging before applying it to production.

- Read the release's migration and compatibility notes before a [Helm upgrade](/docs/admin/deployment/helm#upgrade).
- Use [PostgreSQL](/docs/admin/deployment/database) with backups and availability suited to your recovery requirements. The chart's bundled database has one replica.
- Back up PostgreSQL together with authentication, credential-encryption, and [content-encryption keys](/docs/admin/content-encryption). Test restoring them together; losing an encryption key can make saved data unreadable.

## Public Access

Configure [Networking](/docs/admin/deployment/networking#public-urls-and-ingress) before exposing the instance.

- Use HTTPS and configure the public UI and API URLs to match your ingress.
- Test a streaming model request and an MCP tool call through the public endpoint. Set proxy timeouts for long responses.
- For MCP Apps that need persistent browser storage, configure a [sandbox domain](/docs/admin/deployment/networking#mcp-apps-sandbox).

## Cluster Capacity

For a team of about 100 users, start with the following allocation for LLM Proxy and MCP Gateway traffic, with light background processing. This is a planning starting point: size against simultaneous requests, payloads, and background work in staging before serving production traffic.

| Component | Replicas | CPU per Replica | Memory per Replica |
| --- | ---: | ---: | --- |
| Web | 2 | 2 vCPU request | 2 GiB request, 3 GiB limit |
| Worker | 1 | 2 vCPU request | 1 GiB request, 2 GiB limit |
| External PostgreSQL | Managed separately | 2 vCPU | 8 GiB |

The application pods request **6 vCPU and 5 GiB** in total, excluding PostgreSQL, cluster services, and MCP or agent workloads. Leave additional node capacity for rollout overlap and node failures. The pod resource sizes above match chart defaults; set the replica counts and database budget explicitly:

```yaml
archestra:
  replicaCount: 2
  worker:
    replicaCount: 1
  database:
    connectionBudget: 200
```

For this budget, configure PostgreSQL with at least 250 available connections, reserving 50 for migrations, monitoring, and other clients. [Connection Capacity](/docs/admin/deployment/database#connection-capacity) explains how rollout overlap and autoscaling change the budget.

The [benchmarks](/docs/admin/performance-benchmarks#llm-proxy-results) measured 50 concurrent requests with mock providers on a different allocation: 4 CPUs and 8 GiB for each proxy. They are a throughput reference, not a measured capacity guarantee for this starting configuration.

- Increase [web capacity](/docs/admin/deployment/helm#scale-web-and-worker-pods) when request latency or resource pressure rises; increase workers when background jobs fall behind.
- Reserve separate capacity for [Agent Runtime](/docs/agents/runtime/setup) and the [code sandbox](/docs/admin/deployment/networking#code-sandbox-requirements).
- Verify that your network dataplane [enforces workload egress policies](/docs/admin/deployment/networking#enforce-workload-egress). Policy objects alone do not isolate workloads.

## Infrastructure as Code

Manage Archestra resources such as agents, MCP server installations, and environments declaratively after installing the platform.

- **Terraform:** use the [Terraform provider](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs).
- **Crossplane:** use the [Crossplane provider](https://marketplace.upbound.io/providers/archestra/provider-archestra/v3.0.3) to declare Archestra resources as Kubernetes objects.

Use a dedicated [service account](/docs/reference/api#service-accounts) for automation. The [provider repository](https://github.com/archestra-ai/terraform-provider-archestra) contains source code and examples for both providers.
