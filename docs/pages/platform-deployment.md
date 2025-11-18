---
title: Deployment
category: Archestra Platform
order: 2
---

The Archestra Platform can be deployed using Docker for development and testing, or Helm for production environments. Both deployment methods provide access to the Admin UI on port 3000 and the API on port 9000.

## Environment Variables

The following environment variables can be used to configure Archestra Platform:

- **`ARCHESTRA_DATABASE_URL`** - PostgreSQL connection string for the database.
  - Format: `postgresql://user:password@host:5432/database`
  - Default: Internal PostgreSQL (Docker) or managed instance (Helm)
  - Required for production deployments with external database

- **`ARCHESTRA_API_BASE_URL`** - Base URL for the Archestra API proxy. This is where your agents should connect to instead of the LLM provider directly.
  - Default: `http://localhost:9000`
  - Example: `http://localhost:9001` or `https://api.example.com`
  - Note: This configures both the port where the backend API server listens (parsed from the URL) and the base URL that the frontend uses to connect to the backend

- **`ARCHESTRA_FRONTEND_URL`** - The URL where users access the frontend application.
  - Example: `https://frontend.example.com`
  - Optional for local development

- **`ARCHESTRA_AUTH_COOKIE_DOMAIN`** - Cookie domain configuration for authentication.
  - Should be set to the domain of the `ARCHESTRA_FRONTEND_URL`
  - Example: If frontend is at `https://frontend.example.com`, set to `example.com`
  - Required when using different domains or subdomains for frontend and backend

- **`ARCHESTRA_AUTH_SECRET`** - Secret key used for signing authentication tokens and passwords.
  - Auto-generated once on first run. Set manually if you need to control the secret value.
  - Example: `something-really-really-secret-12345`

- **`ARCHESTRA_AUTH_ADMIN_EMAIL`** - Email address for the default Archestra Admin user, created on startup.
  - Default: `admin@localhost.ai`

- **`ARCHESTRA_AUTH_ADMIN_PASSWORD`** - Password for the default Archestra Admin user. Set once on first-run.
  - Default: `password`
  - Note: Change this to a secure password for production deployments

- **`ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE`** - Kubernetes namespace to run MCP server pods.
  - Default: `default`
  - Example: `archestra-mcp` or `production`

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE`** - Base Docker image for MCP servers.
  - Default: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.3`
  - Can be overridden per individual MCP server.

- **`ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER`** - Use in-cluster config when running inside Kubernetes.
  - Default: `true`
  - Set to `false` when Archestra is deployed in the different cluster and specify the `ARCHESTRA_ORCHESTRATOR_KUBECONFIG`.

- **`ARCHESTRA_ORCHESTRATOR_KUBECONFIG`** - Path to custom kubeconfig file. Mount the required kubeconfig as volume inside the
  - Optional: Uses default locations if not specified
  - Example: `/path/to/kubeconfig`

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT`** - OTEL Exporter endpoint for sending traces
  - Default: `http://localhost:4318/v1/traces`

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME`** - Username for OTEL basic authentication
  - Optional: Only used if both username and password are provided
  - Example: `your-username`

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD`** - Password for OTEL basic authentication
  - Optional: Only used if both username and password are provided
  - Example: `your-password`

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER`** - Bearer token for OTEL authentication
  - Optional: Takes precedence over basic authentication if provided
  - Example: `your-bearer-token`

- **`ARCHESTRA_ANALYTICS`** - Controls PostHog analytics for product improvements.
  - Default: `enabled`
  - Set to `disabled` to opt-out of analytics

- **`ARCHESTRA_LOGGING_LEVEL`** - Log level for Archestra
  - Default: `info`
  - Supported values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`

- **`ARCHESTRA_METRICS_SECRET`** - Bearer token for authenticating metrics endpoint access
  - Default: `archestra-metrics-secret`
  - Note: When set, clients must include `Authorization: Bearer <token>` header to access `/metrics`

## Docker Deployment

Docker deployment provides the fastest way to get started with Archestra Platform, ideal for development and testing purposes.

### Docker Prerequisites

- **Docker** - Container runtime ([Install Docker](https://docs.docker.com/get-docker/))

### Basic Deployment

Run the platform with a single command:

```bash
docker run -p 9000:9000 -p 3000:3000 archestra/platform
```

This will start the platform with:

- **Admin UI** available at <http://localhost:3000>
- **API** available at <http://localhost:9000>
- **Auth Secret** auto-generated and saved to `/app/data/.auth_secret` (persisted across restarts)

### Using External PostgreSQL

To use an external PostgreSQL database, pass the `DATABASE_URL` environment variable:

```bash
docker run -p 9000:9000 -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:password@host:5432/database \
  archestra/platform
```

⚠️ **Important**: If you don't specify `DATABASE_URL`, PostgreSQL will run inside the container for you. This approach is meant for **development and tinkering purposes only** and is **not intended for production**, as the data is not persisted when the container stops.

## Helm Deployment (Recommended for Production)

Helm deployment is our recommended approach for deploying Archestra Platform to production environments.

### Helm Prerequisites

- **Kubernetes cluster** - A running Kubernetes cluster
- **Helm 3+** - Package manager for Kubernetes ([Install Helm](https://helm.sh/docs/intro/install/))
- **kubectl** - Kubernetes CLI ([Install kubectl](https://kubernetes.io/docs/tasks/tools/))

### Installation

Install Archestra Platform using the Helm chart from our OCI registry:

```bash
helm upgrade archestra-platform \
  oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts/archestra-platform \
  --install \
  --namespace archestra \
  --create-namespace \
  --wait
```

This command will:

- Install or upgrade the release named `archestra-platform`
- Create the namespace `archestra` if it doesn't exist
- Wait for all resources to be ready

### Configuration

The Helm chart provides extensive configuration options through values. For the complete configuration reference, see the [values.yaml file](https://github.com/archestra-ai/archestra/blob/main/platform/helm/values.yaml).

#### Core Configuration

**Archestra Platform Settings**:

- `archestra.image` - Docker image for the Archestra Platform (contains both backend API and frontend). See [available tags](https://hub.docker.com/r/archestra/platform/tags)
- `archestra.env` - Environment variables to pass to the container (see Environment Variables section above for available options)

**Example**:

```bash
helm upgrade archestra-platform \
  oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts/archestra-platform \
  --install \
  --namespace archestra \
  --create-namespace \
  --set archestra.env.ARCHESTRA_API_BASE_URL=https://api.example.com \
  --set archestra.env.ARCHESTRA_AUTH_SECRET=better-auth-secret-123456789 \
  --wait
```

Note: `ARCHESTRA_AUTH_SECRET` is optional. It will be auto-generated if not specified.

#### MCP Server Runtime Configuration

**Orchestrator Settings**:

- `archestra.orchestrator.baseImage` - Base Docker image for MCP server containers (defaults to official Archestra MCP server base image)

**Kubernetes Settings**:

- `archestra.orchestrator.kubernetes.namespace` - Kubernetes namespace where MCP server pods will be created (defaults to Helm release namespace)
- `archestra.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster` - Use in-cluster configuration (recommended when running inside K8s)
- `archestra.orchestrator.kubernetes.kubeconfig.enabled` - Enable mounting kubeconfig from a secret
- `archestra.orchestrator.kubernetes.kubeconfig.secretName` - Name of secret containing kubeconfig file
- `archestra.orchestrator.kubernetes.kubeconfig.mountPath` - Path where kubeconfig will be mounted
- `archestra.orchestrator.kubernetes.serviceAccount.create` - Create a service account (default: true)
- `archestra.orchestrator.kubernetes.serviceAccount.annotations` - Annotations to add to the service account
- `archestra.orchestrator.kubernetes.serviceAccount.name` - Name of the service account (auto-generated if not set)
- `archestra.orchestrator.kubernetes.serviceAccount.imagePullSecrets` - Image pull secrets for the service account
- `archestra.orchestrator.kubernetes.rbac.create` - Create RBAC resources (default: true)

#### Service & Ingress Configuration

**Service Settings**:

- `archestra.service.annotations` - Annotations to add to the Kubernetes Service for cloud provider integrations

**Ingress Settings**:

- `archestra.ingress.enabled` - Enable or disable ingress creation (default: false)
- `archestra.ingress.annotations` - Annotations for ingress controller and load balancer behavior
- `archestra.ingress.spec` - Complete ingress specification for advanced configurations

#### Database Configuration

**PostgreSQL Settings**:

- `postgresql.external_database_url` - External PostgreSQL connection string (recommended for production)
- `postgresql.enabled` - Enable managed PostgreSQL instance (default: true, disabled if external_database_url is set)

For external PostgreSQL (recommended for production):

```bash
helm upgrade archestra-platform \
  oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts/archestra-platform \
  --install \
  --namespace archestra \
  --create-namespace \
  --set postgresql.external_database_url=postgresql://user:password@host:5432/database \
  --wait
```

If you don't specify `postgresql.external_database_url`, the chart will deploy a managed PostgreSQL instance using the Bitnami PostgreSQL chart. For PostgreSQL-specific configuration options, see the [Bitnami PostgreSQL Helm chart documentation](https://artifacthub.io/packages/helm/bitnami/postgresql?modal=values-schema).

### Accessing the Platform

After installation, access the platform using port forwarding:

```bash
# Forward the API (port 9000) and the Admin UI (port 3000)
kubectl --namespace archestra port-forward svc/archestra-platform 9000:9000 3000:3000
```

Then visit:

- **Admin UI**: <http://localhost:3000>
- **API**: <http://localhost:9000>

## Infrastructure as Code

### Terraform

For managing Archestra Platform resources, you can use our official Terraform provider to manage Archestra Platform declaratively.

For complete documentation, examples, and resource reference, visit the [Archestra Terraform Provider Documentation](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs).
