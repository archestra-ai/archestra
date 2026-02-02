# Archestra Technical Deep-Dive

This document provides a technical overview of the Archestra platform, intended to help developers understand the project's architecture, technology stack, and development process.

## Project Overview and Purpose

Archestra is a centralized, MCP-native AI platform designed to simplify the use of AI within an organization. It provides a suite of tools for both platform teams and developers to manage, secure, and observe AI agents and their interactions with various data sources. The platform focuses on mitigating the risks associated with AI, such as data exfiltration and prompt injection, while also providing cost management and observability features.

## Repository Structure

The Archestra repository is a monorepo containing the following key directories:

-   `docs/`: Contains the project's documentation, including conceptual guides, tutorials, and API references.
-   `platform/`: The core of the Archestra platform, which is further divided into:
    -   `backend/`: The backend service, built with Fastify and TypeScript.
    -   `frontend/`: The web-based user interface, built with Next.js and React.
    -   `helm/`: Helm charts for deploying the platform to Kubernetes.
    -   `shared/`: Shared code and types used by both the frontend and backend.

## High-Level Architecture

The Archestra platform is composed of a frontend, a backend, and a suite of supporting services that are orchestrated using Kubernetes.

-   **Frontend**: The frontend is a Next.js application that provides a user-friendly interface for managing MCPs, monitoring costs, and interacting with AI agents.
-   **Backend**: The backend is a Fastify-based service that exposes a REST API for the frontend and manages the core logic of the platform. This includes user authentication, MCP orchestration, and security policy enforcement.
-   **MCP Gateway**: The MCP Gateway is a unified access point for all MCP servers, allowing AI agents to discover and interact with them through a single endpoint.

## Technology Stack

### Backend

-   **Framework**: [Fastify](https://www.fastify.io/)
-   **Language**: [TypeScript](https://www.typescriptlang.org/)
-   **Database**: [PostgreSQL](https://www.postgresql.org/)
-   **ORM**: [Drizzle ORM](https://orm.drizzle.team/)
-   **Testing**: [Vitest](https://vitest.dev/)

### Frontend

-   **Framework**: [Next.js](https://nextjs.org/)
-   **Library**: [React](https://reactjs.org/)
-   **Language**: [TypeScript](https://www.typescriptlang.org/)
-   **Styling**: [Tailwind CSS](https://tailwindcss.com/)
-   **Testing**: [Vitest](https://vitest.dev/)

### Monorepo and Tooling

-   **Package Manager**: [pnpm](https://pnpm.io/)
-   **Monorepo Manager**: [Turbo](https://turbo.build/)
-   **Code Formatting and Linting**: [Biome](https://biomejs.dev/)

## Development Environment Setup

To set up a local development environment, you will need the following prerequisites:

-   Node.js (v18-v24)
-   pnpm (v8 or higher)
-   Git
-   Tilt
-   kubectl
-   Helm
-   A local Kubernetes cluster (e.g., Docker Desktop, Kind, OrbStack)

Once the prerequisites are installed, you can set up the development environment with the following commands:

```bash
git clone https://github.com/archestra-ai/archestra.git
cd archestra/platform
tilt up
```

This will build and deploy all the platform services to your local Kubernetes cluster and open the Archestra UI at `http://localhost:3000`.

## Key Concepts

### MCP (Model Context Protocol)

MCP is a central concept in the Archestra platform. It provides a standardized way for AI agents to interact with various tools and data sources. The MCP Gateway acts as a unified access point for all MCP servers, whether they are remote services or locally orchestrated containers.

### Security

Archestra includes several security features to mitigate the risks associated with AI agents:

-   **Security Sub-agents**: These agents isolate dangerous tool responses from the main agent to prevent prompt injections.
-   **Non-probabilistic Security**: This feature is designed to prevent data exfiltration by controlling how AI models access and interact with sensitive information.
-   **Dynamic Tools**: This feature helps to prevent data leaks by dynamically managing the tools available to AI agents based on the context of their task.
