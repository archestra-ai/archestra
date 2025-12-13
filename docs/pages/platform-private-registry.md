---
title: Private MCP Registry
category: Archestra Platform
subcategory: Concepts
order: 4
description: Managing your organization's MCP servers in a private registry
lastUpdated: 2025-10-31
---

<!-- 
Check ../docs_writer_prompt.md before changing this file.

-->

<iframe width="100%" height="400" src="https://www.youtube.com/embed/L_p7CPzFEW0" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>

<br />

![MCP Registry](/docs/automated_screenshots/platform_mcp_registry.png)

The Private MCP Registry is Archestra's centralized repository for managing MCP servers within your organization. It provides **governance and control over AI tool access**, allowing administrators to curate, configure, and control which MCP servers are available to teams, ensuring security, compliance, and standardization across your AI infrastructure.

## Key Features

### Centralized Server Management

The private registry provides a single location to:

- Add and configure MCP servers for your organization
- Manage both remote and local MCP servers
- Control server versions and updates
- Configure authentication and credentials

### Two Types of MCP Servers

#### Remote MCP Servers

Remote servers connect to external services via HTTP/SSE:

- **OAuth Integration**: Built-in support for OAuth authentication
- **API Endpoints**: Direct connection to service APIs
- **Browser Authentication**: Support for browser-based auth flows
- **Managed Credentials**: Secure storage of API keys and tokens

#### Local MCP Servers

Local servers run as containers within your Kubernetes cluster:

- **Custom Docker Images**: Use standard or custom Docker images
- **Environment Configuration**: Inject API keys and configuration
- **Command Arguments**: Configure startup commands and arguments
- **Resource Management**: Control CPU and memory allocation
