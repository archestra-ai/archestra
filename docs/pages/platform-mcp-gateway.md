---
title: MCP Gateway
category: Archestra Platform
subcategory: Concepts
order: 3
description: Unified access point for all MCP servers
lastUpdated: 2025-10-31
---

MCP Gateway is the unified access point for all MCP servers in Archestra Platform. It provides a single endpoint through which AI agents and applications can discover and interact with multiple MCP servers, regardless of whether they are remote services or locally orchestrated containers.

## To use MCP Gateway:

1. Go to "MCP Registry" and install MCP server.
2. Go to "Profiles" -> Wrench Icon -> Assign tools to the profile.
3. Go to "Profiles" -> Connect Icon -> You'll get connection instructions.

```mermaid
graph TB
    subgraph Clients
        direction LR
        A1["AI Agent 1"]
        A2["AI Agent 2"]
        A3["AI Application"]
    end

    subgraph Gateway["Archestra"]
        direction LR
        GW["Gateway<br/>/v1/mcp"]
        Orch["MCP Orchestrator"]

        GW --> Orch
    end

    subgraph Remote["Remote MCP Servers"]
        direction LR
        R1["GitHub MCP"]
    end

    subgraph SelfHosted["Self-hosted MCP Servers"]
        direction LR
        S1["Jira MCP"]
        S2["ServiceNow MCP"]
        S3["Custom MCP"]
    end

    A1 --> GW
    A2 --> GW
    A3 --> GW

    GW --> R1

    Orch --> S1
    Orch --> S2
    Orch --> S3

    style GW fill:#e6f3ff,stroke:#0066cc,stroke-width:2px
    style Orch fill:#fff,stroke:#0066cc,stroke-width:1px
```
