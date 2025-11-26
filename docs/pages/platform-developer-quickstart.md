---
title: Developer Quickstart
category: Development
order: 1
---

<!-- 
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

## Prerequisites

Ensure you have the following tools installed:

### Core Requirements

- **Node.js** (v18 – v24) - JavaScript runtime
- **pnpm** (v8 or higher) - Package manager

  ```bash
  npm install -g pnpm
  ```

- **Git** - Version control

### Kubernetes Development

- **[Tilt](https://docs.tilt.dev/install.html)** - Development environment orchestrator
- **[kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl-macos/)** - Kubernetes CLI
- **[Helm](https://helm.sh/docs/intro/install/)** - Package manager for Kubernetes
- **Local Kubernetes cluster** - Choose one:
  - Docker Desktop with Kubernetes enabled
  - [Kind](https://kind.sigs.k8s.io/) (Kubernetes in Docker)
  - [OrbStack](https://orbstack.dev/) (macOS recommended)

### Development Tools

- **[Biome VSCode extension](https://marketplace.visualstudio.com/items?itemName=biomejs.biome)** - Code formatting and linting

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/archestra-ai/archestra.git
cd archestra/platform
```

### 2. Launch Development Environment

Start the local Kubernetes development environment with Tilt:

```bash
tilt up
```

This command will:

- Build and deploy all platform services to your local Kubernetes cluster
- Set up hot-reload for code changes
- Open the Tilt UI at <http://localhost:10350>
- Open the Archestra UI at <http://localhost:3000>

**Note**: By default, the platform allows localhost origins on any port for CORS configuration. For production deployments or custom CORS configuration, see [Environment Variables](/docs/platform-deployment#environment-variables).

### 3. Dependency Security

The platform has two security protections:

1. **Install scripts are disabled** - Prevents malicious code execution during install
2. **7-day minimum release age** - Delays installation of newly published packages

If a package requires scripts to work:

```bash
pnpm rebuild <package-name>
```

This is rarely needed. Most packages work without scripts.
