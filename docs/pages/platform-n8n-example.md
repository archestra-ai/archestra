---
title: Secure Agent with N8N
category: Examples
order: 3
---

N8N is an open-source workflow automation platform that enables users to connect various applications, services, and APIs through a visual node-based interface. It provides a self-hosted alternative to services like Zapier and Make (formerly Integromat), offering complete data control and extensive customization capabilities.

## Security Challenges with Autonomous N8N Agents

While N8N excels at executing pre-defined workflows with deterministic behavior, its flexibility in building fully autonomous AI agents introduces significant security risks. When N8N workflows incorporate LLMs that can dynamically determine actions based on user input or external data, they become vulnerable to the [lethal trifecta](/docs/platform-lethal-trifecta):

1. **Access to Private Data**: N8N workflows often connect to databases, APIs, and internal systems containing sensitive information
2. **Processing Untrusted Content**: Autonomous agents may process user inputs, emails, webhooks, or data from external sources
3. **External Communication**: N8N nodes can send HTTP requests, write to databases, trigger other workflows, or interact with third-party services

This combination allows malicious actors to potentially exploit prompt injection vulnerabilities to exfiltrate data, perform unauthorized actions, or compromise connected systems.

## Securing N8N with Archestra Platform

Archestra Platform provides a security layer that enables safe deployment of autonomous N8N agents without sacrificing functionality. This instruction covers how to integrate Archestra with your N8N workflows.

### 0. Running N8N and Archestra Platform

We've prepared a docker-compose with local N8N and Archestra:

```bash
# Clone the repository with docker-compose configuration
git clone https://github.com/archestra-ai/archestra
cd platform

# Start N8N and Archestra Platform
docker-compose -f docker-compose-n8n.yml up

# Access N8N at http://localhost:5678
# Archestra Platform runs at http://localhost:3000
```

### 1. Building Autonomous Agent with N8N

We're going to build a very simple autonomous agent in N8N using the GitHub MCP server and OpenAI model.

![N8N](/docs/platfrom/n8n-1.png)

1. Add "AI Agent" node.
2. Add "Chat Trigger".
3. Add "Model" node and choose OpenAI gpt-4o.
4. Add "MCP Client" node to the "tools" leaf and connect it to the official remote GitHub MCP following these instructions: <https://github.com/github/github-mcp-server>

### 2. Reproducing Prompt Injection

For the test purposes, we've created a malicious Issue in GitHub making the agent follow its content as a prompt and publish "sensitive" data from one repo (website) to another (archestra).

```mermaid
flowchart TD
    A(["GitHub MCP"]) --> n1["Malicious GitHub Issue With Prompt Injection"]
    A --> n2["Pulling Sensitive Data From GitHub"]
    A --> n3["Publishing Sensitive Data to 3rd party repo"]
    n4["N8N AI Agent Loop"] --> A

    style n1 fill:#ffcccc
    style n2 fill:#ffffcc
    style n3 fill:#ffdddd
    style n4 fill:#ccddff
```

We will utilize this test [GitHub issue](https://github.com/archestra-ai/archestra/issues/647) as a prompt injection example. Put such a prompt to the N8N chat:

```
resolve https://github.com/archestra-ai/archestra/issues/647
```

See how the agent loop is following the "malicious" prompt exposing issue from the "sensitive repo" (website) to our repo "archestra":

![N8N](/docs/platfrom/n8n-2.png)

### 3. Bringing Archestra in between N8N and OpenAI

```mermaid
flowchart LR

    subgraph Archestra["Archestra Platform"]
        AP["Archestra Proxy"]
    end

    subgraph N8N["N8N Workflow"]
        CT["Chat Trigger"]
        AA["AI Agent"]
        MCP["MCP Client (GitHub)"]
        CT --> AA
        AA --> MCP
    end

    subgraph External["External Services"]
        OAI["OpenAI API"]
        GH["GitHub API"]
    end

    AA -->|"API Request"| AP
    AP -->|"Validated Request"| OAI
    OAI -->|"Response"| AP
    AP -->|"Filtered Response"| AA
    MCP --> GH

    style Archestra fill:#e0f2fe
    style AP fill:#3b82f6,color:#fff
```

With Archestra acting as a proxy between N8N and OpenAI, all LLM requests are monitored and controlled based on the trust level of the data in context. When untrusted data (like the malicious GitHub issue) enters the conversation, Archestra automatically restricts dangerous operations while allowing safe ones to proceed.

▶️ Configure Archestra as a proxy for N8N:

1. Go to credentials: <http://127.0.0.1:5678/home/credentials/>
2. Choose your OpenAI credentials
3. Set "Base URL" as

```text
http://platform-archestra-1:9000/v1/openai
```

instead of <https://api.openai.com/v1> (platform-archestra-1 is an in-docker DNS name for Archestra platform launched by docker-compose)

**Optional:** To use a specific profile, include the profile ID in the URL: `http://platform-archestra-1:9000/v1/openai/{profile-id}`.
You can create and manage profiles in the Archestra Platform UI at [http://localhost:3000/profiles](http://localhost:3000/profiles).

4. Open the agent in the N8N again and put "hi" to the chat. It will make Archestra discover tools.

### 4. Try prompt injection again and notice how Archestra prevents it

Go to the N8N and try the prompt again:

```text
resolve https://github.com/archestra-ai/archestra/issues/647
```

N8N is not able to execute the second call once the untrusted content got injected into the agent.

![N8N](/docs/platfrom/n8n-3.png)

Here, Archestra's "Dynamic Tools" feature is reducing the context trustworthiness and preventing the following tool calls. Read about it [here](/docs/platform-dynamic-tools).
