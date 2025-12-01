---
title: MCP Orchestrator
category: Archestra Platform
subcategory: Concepts
order: 5
description: How Archestra orchestrates MCP servers in Kubernetes
lastUpdated: 2025-10-31
---

<!-- 
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.

Exception:
- Screenshot
-->

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

## Local Development with Docker and Kubernetes

To use a local Kubernetes cluster (like Kind, Minikube, or K3d) for the Archestra Orchestrator, you need to make the cluster accessible from within the Docker container.

1. **Export your local Kubernetes kubeconfig**:

   Export the kubeconfig for your local cluster to a file (e.g., `local-kubeconfig.yaml`).

2. **Change server address to `host.docker.internal` and skip TLS verification**:

   The exported kubeconfig likely uses `127.0.0.1` or `0.0.0.0` for the server address. Since the Archestra container runs in its own network namespace, it cannot reach the host's localhost directly. You need to replace the server address with `host.docker.internal`.

   Additionally, since the TLS certificate for the local cluster is usually issued for localhost/IPs and not `host.docker.internal`, you need to disable TLS verification in the kubeconfig.

   Edit your `local-kubeconfig.yaml` to look like this (replace the server address and add `insecure-skip-tls-verify: true`).

   **⚠️ Important**: Make sure to preserve the `contexts` and `users` sections from your original file. Only modify the `clusters` section.

   ```yaml
   apiVersion: v1
   clusters:
   - cluster:
       # certificate-authority-data: ... (remove or comment out this line)
       insecure-skip-tls-verify: true
       server: https://host.docker.internal:6443 # Replace port with your cluster's port
     name: kind-kind # Keep the original cluster name (e.g. docker-desktop, minikube)
   
   # Keep the rest of the file as is (contexts, users, etc.)
   contexts:
   # ...
   users:
   # ...
   ```

   You can find the port number in the original `server` URL (e.g., if it was `https://127.0.0.1:6443`, the port is 6443).

3. **Run Archestra with Kubernetes configuration**:

   Mount the kubeconfig and configure the orchestrator environment variables.

   ```bash
   docker run -p 9000:9000 -p 3000:3000 \
     --add-host host.docker.internal:host-gateway \
     -v $(pwd)/local-kubeconfig.yaml:/app/kubeconfig \
     -e ARCHESTRA_ORCHESTRATOR_KUBECONFIG=/app/kubeconfig \
     -e ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER=false \
     -e ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE=default \
     archestra/platform
   ```

   > **Note**: The `--add-host host.docker.internal:host-gateway` flag is required on Linux to resolve `host.docker.internal`. On Docker Desktop for Mac/Windows, it is often available by default, but including the flag is safe.
