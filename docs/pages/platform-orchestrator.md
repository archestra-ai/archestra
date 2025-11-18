---
title: MCP Orchestrator
category: Archestra Platform
subcategory: Concepts
order: 5
description: How Archestra orchestrates MCP servers in Kubernetes
lastUpdated: 2025-10-31
---

The MCP Orchestrator is Archestra's system for running and managing MCP servers within your existing Kubernetes cluster. It handles the lifecycle of MCP server pods, manages their secrets securely, and provides unified access through the MCP Gateway.

> **Note:** The MCP Orchestrator requires a Kubernetes (K8s) cluster to operate. You still could use Private MCP Registry, MCP Gateway and security features with remote MCP servers, or self-host them and connect to Archestra.

```mermaid
graph TB
    subgraph K8S["Kubernetes Cluster"]
        subgraph Archestra["Archestra Platform"]
            Gateway["MCP Gateway<br/>(Unified Access)"]
            Orchestrator["MCP Orchestrator<br/>• Pod Lifecycle Management<br/>• Secrets Management<br/>• Access Control"]

            Gateway --> Orchestrator
        end

        Orchestrator --> Pod1["Pod 1<br/>ServiceNow MCP"]
        Orchestrator --> Pod2["Pod 2<br/>GitHub MCP"]
        Orchestrator --> Pod3["Pod 3<br/>Jira MCP"]
        Orchestrator --> Pod4["Pod 4<br/>Jira MCP with<br/>different credentials"]
    end

    style K8S fill:#f9f9f9,stroke:#333,stroke-width:2px
    style Archestra fill:#e6f3ff,stroke:#0066cc,stroke-width:2px
    style Gateway fill:#fff,stroke:#0066cc,stroke-width:2px
    style Orchestrator fill:#fff,stroke:#0066cc,stroke-width:2px
    style Pod1 fill:#fff2cc,stroke:#d6b656,stroke-width:1px
    style Pod2 fill:#fff2cc,stroke:#d6b656,stroke-width:1px
    style Pod3 fill:#fff2cc,stroke:#d6b656,stroke-width:1px
    style Pod4 fill:#fff2cc,stroke:#d6b656,stroke-width:1px
```

## How It Works

Each MCP server runs as a dedicated pod in your Kubernetes cluster:

- **One Pod Per Server**: Each MCP server gets its own isolated pod
- **Automatic Lifecycle**: Pods are automatically created, restarted, and managed
- **Custom Images**: Supports both standard and custom Docker images for MCP servers
- **Secret Management**: The orchestrator injects credentials and configuration.
