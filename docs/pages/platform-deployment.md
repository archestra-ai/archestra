---
title: Deployment
category: Archestra Platform
order: 2
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

The Archestra Platform can be deployed using Docker for development and testing, or Helm for production environments. Both deployment methods provide access to the Admin UI on port 3000 and the API on port 9000.

## Docker Deployment

Docker deployment provides the fastest way to get started with Archestra Platform, ideal for development and testing purposes.

### Docker Prerequisites

- **Docker** - Container runtime ([Install Docker](https://docs.docker.com/get-docker/))

### Basic Deployment

Run the platform with a single command:

```bash
docker pull archestra/platform:latest;
docker run -p 9000:9000 -p 3000:3000 \
   -v archestra-postgres-data:/var/lib/postgresql/data \
   -v archestra-app-data:/app/data \
   archestra/platform;
```

This will start the platform with:

- **Admin UI** available at <http://localhost:3000>
- **API** available at <http://localhost:9000>
- **Auth Secret** auto-generated and saved to `/app/data/.auth_secret` (persisted across restarts)

### Using External PostgreSQL

To use an external PostgreSQL database, pass the `DATABASE_URL` environment variable:

```bash
docker pull archestra/platform:latest;
docker run -p 9000:9000 -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:password@host:5432/database \
  archestra/platform
```

⚠️ **Important**: If you don't specify `DATABASE_URL`, PostgreSQL will run inside the container for you. This approach is meant for **development and tinkering purposes only** and is **not intended for production**, as the data is not persisted when the container stops.

## Helm Deployment

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
  --set archestra.env.HOSTNAME="0.0.0.0" \
  --create-namespace \
  --wait
```

This command will:

- Install or upgrade the release named `archestra-platform`
- Create the namespace `archestra` if it doesn't exist
- Wait for all resources to be ready

### Configuration

The Helm chart provides extensive configuration options through values. For the complete configuration reference, see the [values.yaml file](https://github.com/archestra-ai/archestra/blob/main/platform/helm/archestra/values.yaml).

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
  --wait
```

**Note**: `ARCHESTRA_AUTH_SECRET` is optional and will be auto-generated (64 characters) if not specified. If you need to set it manually, it must be at least 32 characters:

```bash
# Generate a secure secret
openssl rand -base64 32

# Then add to your helm command:
--set archestra.env.ARCHESTRA_AUTH_SECRET=<your-generated-secret>
```

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
- `archestra.orchestrator.kubernetes.serviceAccount.annotations` - Annotations for cloud integrations (e.g., [GKE Workload Identity](/docs/platform-supported-llm-providers#gke-with-workload-identity-recommended), AWS IRSA)
- `archestra.orchestrator.kubernetes.serviceAccount.name` - Name of the service account (auto-generated if not set)
- `archestra.orchestrator.kubernetes.serviceAccount.imagePullSecrets` - Image pull secrets for the service account
- `archestra.orchestrator.kubernetes.rbac.create` - Create RBAC resources (default: true)

#### Service, Deployment, & Ingress Configuration

**Deployment Settings**:

- `archestra.podAnnotations` - Annotations to add to pods (useful for Prometheus, Vault agent, service mesh sidecars, etc.)
- `archestra.resources` - CPU and memory requests/limits for the container (default: 2Gi request, 3Gi limit for memory)

**Service Settings**:

- `archestra.service.annotations` - Annotations to add to the Kubernetes Service for cloud provider integrations

**Ingress Settings**:

- `archestra.ingress.enabled` - Enable or disable ingress creation (default: false)
- `archestra.ingress.annotations` - Annotations for ingress controller and load balancer behavior
- `archestra.ingress.spec` - Complete ingress specification for advanced configurations

**GKE BackendConfig Settings** (Google Cloud only):

- `archestra.gkeBackendConfig.enabled` - Enable or disable GKE BackendConfig resources (default: false)
- `archestra.gkeBackendConfig.backend.timeoutSec` - Request timeout for backend API (recommended: 600 for streaming)
- `archestra.gkeBackendConfig.backend.connectionDraining.drainingTimeoutSec` - Connection draining timeout for backend
- `archestra.gkeBackendConfig.backend.healthCheck` - Health check configuration for backend (port 9000)
- `archestra.gkeBackendConfig.frontend.timeoutSec` - Request timeout for frontend
- `archestra.gkeBackendConfig.frontend.connectionDraining.drainingTimeoutSec` - Connection draining timeout for frontend
- `archestra.gkeBackendConfig.frontend.healthCheck` - Health check configuration for frontend (port 3000)

#### Cloud Provider Configuration (Streaming Timeout Settings)

**⚠️ IMPORTANT:** Archestra Platform requires proper timeout settings on the upstream load balancer. **Without longer timeouts, streaming responses may end prematurely**, resulting in a “network error”

##### Google Cloud Platform (GKE)

For GKE deployments using the GCE Ingress Controller, configure load balancer timeouts and health checks using BackendConfig resources. The Helm chart can create and manage these resources for you.

Enable the `gkeBackendConfig` section in your values:

```yaml
archestra:
  gkeBackendConfig:
    enabled: true
    backend:
      timeoutSec: 600 # 10 minutes for streaming responses
      connectionDraining:
        drainingTimeoutSec: 60
    frontend:
      timeoutSec: 600
      connectionDraining:
        drainingTimeoutSec: 60
  service:
    annotations:
      cloud.google.com/backend-config: '{"ports": {"9000":"RELEASE_NAME-archestra-platform-backend-config", "3000":"RELEASE_NAME-archestra-platform-frontend-config"}}'
```

Apply via Helm (replace `RELEASE_NAME` with your actual release name, e.g., `archestra-platform`):

```bash
helm upgrade archestra-platform \
  oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts/archestra-platform \
  --install \
  --namespace archestra \
  --create-namespace \
  --set archestra.gkeBackendConfig.enabled=true \
  --set archestra.gkeBackendConfig.backend.timeoutSec=600 \
  --set archestra.gkeBackendConfig.frontend.timeoutSec=600 \
  --set-string archestra.service.annotations."cloud\.google\.com/backend-config"='{"ports": {"9000":"archestra-platform-archestra-platform-backend-config", "3000":"archestra-platform-archestra-platform-frontend-config"}}' \
  --wait
```

The Helm chart creates two BackendConfig resources with health checks tuned for deployments:

- `<release>-archestra-platform-backend-config` - For the API backend (port 9000)
- `<release>-archestra-platform-frontend-config` - For the frontend (port 3000)

##### Amazon Web Services (AWS EKS)

For AWS EKS with Application Load Balancer (ALB), configure timeout annotations on the Service:

```yaml
archestra:
  service:
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "http"
      service.beta.kubernetes.io/aws-load-balancer-connection-idle-timeout: "600"
```

Apply via Helm:

```bash
helm upgrade archestra-platform \
  oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts/archestra-platform \
  --install \
  --namespace archestra \
  --create-namespace \
  --set-string archestra.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-backend-protocol"=http \
  --set-string archestra.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-connection-idle-timeout"="600" \
  --wait
```

##### Microsoft Azure (AKS)

For Azure AKS with Application Gateway Ingress Controller (AGIC), configure timeout annotations on the Ingress:

```yaml
archestra:
  ingress:
    enabled: true
    annotations:
      appgw.ingress.kubernetes.io/request-timeout: "600"
      appgw.ingress.kubernetes.io/connection-draining-timeout: "60"
```

Apply via Helm:

```bash
helm upgrade archestra-platform \
  oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts/archestra-platform \
  --install \
  --namespace archestra \
  --create-namespace \
  --set archestra.ingress.enabled=true \
  --set-string archestra.ingress.annotations."appgw\.ingress\.kubernetes\.io/request-timeout"="600" \
  --set-string archestra.ingress.annotations."appgw\.ingress\.kubernetes\.io/connection-draining-timeout"="60" \
  --wait
```

##### Other Ingress Controllers (nginx, Traefik, etc.)

For nginx-ingress:

```yaml
archestra:
  ingress:
    enabled: true
    annotations:
      nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
      nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
```

For Traefik:

```yaml
archestra:
  ingress:
    enabled: true
    annotations:
      traefik.ingress.kubernetes.io/service.passhostheader: "true"
      # Configure timeout via Traefik IngressRoute or Middleware
```

#### Scaling & High Availability Configuration

**HorizontalPodAutoscaler Settings**:

- `archestra.horizontalPodAutoscaler.enabled` - Enable or disable HorizontalPodAutoscaler creation (default: false)
- `archestra.horizontalPodAutoscaler.minReplicas` - Minimum number of replicas (default: 1)
- `archestra.horizontalPodAutoscaler.maxReplicas` - Maximum number of replicas (default: 10)
- `archestra.horizontalPodAutoscaler.metrics` - Metrics configuration for scaling decisions
- `archestra.horizontalPodAutoscaler.behavior` - Scaling behavior configuration

**Example with CPU-based autoscaling**:

```yaml
archestra:
  horizontalPodAutoscaler:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    metrics:
      - type: Resource
        resource:
          name: cpu
          target:
            type: Utilization
            averageUtilization: 80
    behavior:
      scaleDown:
        stabilizationWindowSeconds: 300
        policies:
          - type: Percent
            value: 10
            periodSeconds: 60
      scaleUp:
        stabilizationWindowSeconds: 0
        policies:
          - type: Percent
            value: 100
            periodSeconds: 15
```

**PodDisruptionBudget Settings**:

- `archestra.podDisruptionBudget.enabled` - Enable or disable PodDisruptionBudget creation (default: false)
- `archestra.podDisruptionBudget.minAvailable` - Minimum number of pods that must remain available (integer or percentage)
- `archestra.podDisruptionBudget.maxUnavailable` - Maximum number of pods that can be unavailable (integer or percentage)
- `archestra.podDisruptionBudget.unhealthyPodEvictionPolicy` - Policy for evicting unhealthy pods (IfHealthyBudget or AlwaysAllow)

**Note**: Only one of `minAvailable` or `maxUnavailable` can be set.

**Example with minAvailable**:

```yaml
archestra:
  podDisruptionBudget:
    enabled: true
    minAvailable: 1
    unhealthyPodEvictionPolicy: IfHealthyBudget
```

**Example with maxUnavailable percentage**:

```yaml
archestra:
  podDisruptionBudget:
    enabled: true
    maxUnavailable: "25%"
```

See the Kubernetes documentation for more details:

- [HorizontalPodAutoscaler](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [PodDisruptionBudget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)

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

### Production Recommendations

#### PostgreSQL Infrastructure

For production deployments, we strongly recommend using a cloud-hosted PostgreSQL database instead of the bundled PostgreSQL instance. Cloud-managed databases provide:

- **High availability** with automatic failover
- **Automated backups** and point-in-time recovery
- **Scaling** without downtime
- **Security** with encryption at rest and in transit
- **Monitoring** and alerting out of the box

To use an external database, specify the connection string via the `ARCHESTRA_DATABASE_URL` environment variable. When using an external database, the bundled PostgreSQL instance is automatically disabled. See the [Environment Variables](#environment-variables) section for details.

## Infrastructure as Code

### Terraform

For managing Archestra Platform resources, you can use our official Terraform provider to manage Archestra Platform declaratively.

**Provider Configuration**:

```terraform
terraform {
  required_providers {
    archestra = {
      source = "archestra-ai/archestra"
    }
  }
}

provider "archestra" {
  base_url = "http://localhost:9000" # Your Archestra API URL
  api_key  = "your-api-key-here"     # Can also use ARCHESTRA_API_KEY env var
}
```

**Obtaining an API Key**: See the [API Reference](/docs/platform-api-reference#authentication) documentation for instructions on creating an API key.

**Configuring `base_url`**:

The `base_url` should match your `ARCHESTRA_API_BASE_URL` environment variable — this is where your Archestra Platform API is accessible:

- **Local development**: `http://localhost:9000` (default)
- **Production**: Your externally-accessible API URL (e.g., `https://api.archestra.example.com`)

You can also set these values via environment variables instead of hardcoding them:

```bash
export ARCHESTRA_API_KEY="your-api-key-here"
export ARCHESTRA_BASE_URL="https://api.archestra.example.com"
```

For complete documentation, examples, and resource reference, visit the [Archestra Terraform Provider Documentation](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs).

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

  - Auto-generated once on first run. Set manually if you need to control the secret value. Must be at least 32 characters long.
  - Example: `something-really-really-secret-12345`

- **`ARCHESTRA_AUTH_ADMIN_EMAIL`** - Email address for the default Archestra Admin user, created on startup.

  - Default: `admin@localhost.ai`

- **`ARCHESTRA_AUTH_ADMIN_PASSWORD`** - Password for the default Archestra Admin user. Set once on first-run.

  - Default: `password`
  - Note: Change this to a secure password for production deployments

- **`ARCHESTRA_AUTH_DISABLE_BASIC_AUTH`** - Hides the username/password login form on the sign-in page.

  - Default: `false`
  - Set to `true` to disable basic authentication and require users to authenticate via SSO only
  - Note: Configure at least one SSO provider before enabling this option. See [Single Sign-On](/docs/platform-single-sign-on) for SSO configuration.

- **`ARCHESTRA_AUTH_DISABLE_INVITATIONS`** - Disables user invitations functionality.

  - Default: `false`
  - Set to `true` to hide invitation-related UI and block invitation API endpoints
  - When enabled, administrators cannot create new invitations, and the invitation management UI is hidden
  - Useful for environments where user provisioning is handled externally (e.g., via SSO with automatic provisioning)

- **`ARCHESTRA_OPENAI_BASE_URL`** - Override the OpenAI API base URL.

  - Default: `https://api.openai.com/v1`
  - Use this to point to your own proxy, an OpenAI-compatible API, or other custom endpoints

- **`ARCHESTRA_ANTHROPIC_BASE_URL`** - Override the Anthropic API base URL.

  - Default: `https://api.anthropic.com`
  - Use this to point to your own proxy or other custom endpoints

- **`ARCHESTRA_GEMINI_BASE_URL`** - Override the Google Gemini API base URL.

  - Default: `https://generativelanguage.googleapis.com`
  - Use this to point to your own proxy or other custom endpoints
  - Note: This is only used when Vertex AI mode is disabled

- **`ARCHESTRA_GEMINI_VERTEX_AI_ENABLED`** - Enable Vertex AI mode for Gemini.

  - Default: `false`
  - Set to `true` to use Vertex AI instead of the Google AI Studio API
  - When enabled, uses Application Default Credentials (ADC) for authentication instead of API keys
  - Requires `ARCHESTRA_GEMINI_VERTEX_AI_PROJECT` to be set
  - See: [Vertex AI setup guide](/docs/platform-supported-llm-providers#using-vertex-ai)

- **`ARCHESTRA_GEMINI_VERTEX_AI_PROJECT`** - Google Cloud project ID for Vertex AI.

  - Required when: `ARCHESTRA_GEMINI_VERTEX_AI_ENABLED=true`
  - Example: `my-gcp-project-123`

- **`ARCHESTRA_GEMINI_VERTEX_AI_LOCATION`** - Google Cloud location/region for Vertex AI.

  - Default: `us-central1`
  - Example: `us-central1`, `europe-west1`, `asia-northeast1`

- **`ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE`** - Path to Google Cloud service account JSON key file.

  - Optional: Only needed when running outside of GCP or without Workload Identity
  - Example: `/path/to/service-account-key.json`
  - When not set, uses [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials)
  - See: [Vertex AI setup guide](/docs/platform-supported-llm-providers#using-vertex-ai)

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

- **`ARCHESTRA_ORCHESTRATOR_MCP_K8S_SERVICE_ACCOUNT_NAME`** - Kubernetes ServiceAccount name for MCP server pods that need K8s API access.

  - Default: `archestra-platform-mcp-k8s-operator`
  - The official Helm chart creates a ServiceAccount with this name pattern: `{release-name}-mcp-k8s-operator`
    So, default value matches it when using `archestra-platform` as the release name.
  - Customize if using a different Helm release name or managing ServiceAccounts manually

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

- **`ARCHESTRA_SECRETS_MANAGER`** - Secrets storage backend for managing sensitive data (API keys, tokens, etc.)

  - Default: `DB` (database storage)
  - Options: `DB` or `Vault`
  - Note: When set to `Vault`, requires `HASHICORP_VAULT_ADDR` and `HASHICORP_VAULT_TOKEN` to be configured

- **`ARCHESTRA_HASHICORP_VAULT_ADDR`** - HashiCorp Vault server address

  - Required when: `ARCHESTRA_SECRETS_MANAGER=Vault`
  - Example: `http://localhost:8200`
  - Note: System falls back to database storage if Vault is configured but credentials are missing

- **`ARCHESTRA_HASHICORP_VAULT_TOKEN`** - HashiCorp Vault authentication token

  - Required when: `ARCHESTRA_SECRETS_MANAGER=Vault`
  - Note: System falls back to database storage if Vault is configured but credentials are missing

- **`ARCHESTRA_CHAT_<PROVIDER>_API_KEY`** - LLM provider API keys for the built-in Chat feature.

  - Pattern: `ARCHESTRA_CHAT_ANTHROPIC_API_KEY`, `ARCHESTRA_CHAT_OPENAI_API_KEY`, `ARCHESTRA_CHAT_GEMINI_API_KEY`
  - These serve as fallback API keys when no organization default or profile-specific key is configured
  - See [Chat](/docs/platform-chat) for full details on API key configuration and resolution order

- **`ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED`** - Activates enterprise features in Archestra.
  - Please reach out to sales@archestra.ai to learn more about the license.
