---
title: MCP Orchestrator
category: MCP Gateway
order: 3
description: How Archestra orchestrates MCP servers in Kubernetes
lastUpdated: 2025-10-31
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.

Exception:
- Screenshot
-->

The MCP Orchestrator is Archestra's system for running and managing MCP servers within your existing Kubernetes cluster. It handles the lifecycle of MCP server deployments, manages their secrets securely, and provides unified access through the MCP Gateway.

> **Note:** The MCP Orchestrator requires a Kubernetes (K8s) cluster to operate. You still could use Private MCP Registry, MCP Gateway and security features with remote MCP servers, or self-host them and connect to Archestra.

```mermaid
graph TB
    subgraph K8S["Kubernetes Cluster"]
        subgraph Archestra["Archestra Platform"]
            Gateway["MCP Gateway<br/>(Unified Access)"]
            Orchestrator["MCP Orchestrator<br/>• Deployment Lifecycle<br/>• Secrets Management<br/>• Access Control"]

            Gateway --> Orchestrator
        end

        Orchestrator --> D1["ServiceNow MCP"]
        Orchestrator --> D2["GitHub MCP"]
        Orchestrator --> D3["Jira MCP"]
        Orchestrator --> D4["Jira MCP<br/>(different credentials)"]
    end

    style K8S fill:#f9f9f9,stroke:#333,stroke-width:2px
    style Archestra fill:#e6f3ff,stroke:#0066cc,stroke-width:2px
    style Gateway fill:#fff,stroke:#0066cc,stroke-width:2px
    style Orchestrator fill:#fff,stroke:#0066cc,stroke-width:2px
    style D1 fill:#fff2cc,stroke:#d6b656,stroke-width:1px
    style D2 fill:#fff2cc,stroke:#d6b656,stroke-width:1px
    style D3 fill:#fff2cc,stroke:#d6b656,stroke-width:1px
    style D4 fill:#fff2cc,stroke:#d6b656,stroke-width:1px
```

## How It Works

### Deployments

Each MCP server runs as a dedicated Kubernetes Deployment:

- **One Deployment Per Server**: Each MCP server gets its own isolated deployment
- **Automatic Lifecycle**: Deployments are automatically created, restarted, and managed
- **Custom Images**: Supports both standard and custom Docker images for MCP servers
- **Secret Management**: The orchestrator injects credentials and configuration

### Credentials

The orchestrator securely manages credentials for each MCP server. When you install a server from the [Private Registry](/docs/platform-private-registry), you authenticate with the external service — the resulting credential is stored and injected into the deployment at runtime.

Credentials can be **personal** (owned by a single user) or **team-scoped** (shared by all members of a team). When assigning tools to an MCP Gateway or Agent, you choose a specific credential or select "Resolve at call time" for dynamic per-user credential resolution.

> **Note:** For local MCP servers (running as K8s deployments), the "credential" is the deployment itself. The orchestrator routes tool calls to the correct deployment rather than injecting API tokens.

See [Authentication](/docs/mcp-authentication) for the full credential resolution logic, per-user credentials, and missing credential handling.
