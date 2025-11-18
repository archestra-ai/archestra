---
title: LLM Proxy
category: Archestra Platform
subcategory: Concepts
order: 2
description: Secure proxy for LLM provider interactions
lastUpdated: 2025-10-31
---

LLM Proxy is Archestra's security layer that sits between AI agents and LLM providers (OpenAI, Anthropic, Google, etc.). It intercepts, analyzes, and modifies LLM requests and responses to enforce security policies, prevent data leakage, and ensure compliance with organizational guidelines.

## To use LLM Proxy:

Go to "Profiles" -> Connect Icon -> You'll get connection instructions.

```mermaid
graph TB
    subgraph Applications
        direction LR
        A1["AI Agent"]
        A2["Chatbot"]
        A3["AI App"]
    end

    subgraph Proxy["Archestra"]
        direction LR
        Entry["Entry Point<br/>:9000/v1/*"]
        Guard["Guardrails"]
        Modifier["Response Modifier"]

        Entry --> Guard
        Guard --> Modifier
    end

    subgraph Providers["LLM Providers"]
        direction LR
        P1["OpenAI"]
        P2["Anthropic"]
        P3["Google AI"]
        P4["Custom LLM"]
    end

    A1 --> Entry
    A2 --> Entry
    A3 --> Entry

    Modifier --> P1
    Modifier --> P2
    Modifier --> P3
    Modifier --> P4

    P1 -.->|Response| Modifier
    P2 -.->|Response| Modifier
    P3 -.->|Response| Modifier
    P4 -.->|Response| Modifier

    style Entry fill:#e6f3ff,stroke:#0066cc,stroke-width:2px
    style Guard fill:#fff2cc,stroke:#d6b656,stroke-width:2px
    style Modifier fill:#fff,stroke:#0066cc,stroke-width:1px
```
