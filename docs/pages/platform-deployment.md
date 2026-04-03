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

Docker deployment provides the fastest way to get started with Archestra Platform, ideal for tinkering and testing purposes.

### Docker Prerequisites

- **Docker** - Container runtime ([Install Docker](https://docs.docker.com/get-docker/))

### Quickstart Deployment

Run the platform with a single command:

**Linux / macOS:**

```bash
docker pull archestra/platform:latest;
docker run -p 9000:9000 -p 3000:3000\
   -e ARCHESTRA_QUICKSTART=true \
   -v /var/run/docker.sock:/var/run/docker.sock \
   -v archestra-postgres-data:/var/lib/postgresql/data \
   -v archestra-app-data:/app/data \
   archestra/platform;
```

**Windows (PowerShell):**

```powershell
docker pull archestra/platform:latest;
docker run -p 9000:9000 -p 3000:3000`
   -e ARCHESTRA_QUICKSTART=true `
   -v /var/run/docker.sock:/var/run/docker.sock `
   -v archestra-postgres-data:/var/lib/postgresql/data `
   -v archestra-app-data:/app/data `
   archestra/platform;
```

This will start the platform with:

- **Admin UI** available at <http://localhost:3000>
- **API** available at <http://localhost:9000>
- **Auth Secret** auto-generated and saved to `/app/data/.auth_secret` (persisted across restarts)
- **MCP Kubernetes Orchestrator** via KinD

**Note**: The `-v /var/run/docker.sock:/var/run/docker.sock` mount enables the embedded Kubernetes cluster for MCP server execution. This is required for the quick-start Docker deployment. For production, use the Helm deployment with an external Kubernetes cluster instead.

> **Accessing from another device on your network?** In quickstart mode, private network IPs (e.g., `192.168.x.x`, `10.x.x.x`) are automatically trusted, so authentication works without extra configuration.

If you have Kubernetes installed locally, you can use it for the MCP orchestrator. Make sure `kubectl` points to the right cluster and run the container without the socket and without `ARCHESTRA_QUICKSTART`. The orchestrator will create a cluster in the current context. See [Development with Standalone Kubernetes](./platform-orchestrator#local-development-with-docker-and-standalone-kubernetes)

```diff
docker run -p 9000:9000 -p 3000:3000\
-  -e ARCHESTRA_QUICKSTART=true \
-  -v /var/run/docker.sock:/var/run/docker.sock \
   -v archestra-postgres-data:/var/lib/postgresql/data \
   -v archestra-app-data:/app/data \
   archestra/platform;
```

Running the platform without Kubernetes (or its alternatives) is also possible. This just makes MCP orchestrator unavailable in the app.

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

- `archestra.image` - Docker image repository for the Archestra Platform (default: `archestra/platform`). See [available tags](https://hub.docker.com/r/archestra/platform/tags)
- `archestra.imageTag` - Image tag for the Archestra Platform. New Helm releases update this value to latest available image tag.
- `archestra.imagePullPolicy` - Image pull policy for the Archestra container (default: IfNotPresent). Options: Always, IfNotPresent, Never
- `archestra.replicaCount` - Number of pod replicas (default: 1). Ignored when HPA is enabled
- `archestra.env` - Environment variables to pass to the container (see Environment Variables section for available options). Supports Kubernetes `$(VAR_NAME)` expansion syntax.
- `archestra.authSecret.extraData` - Additional plain-text key/value pairs to add to the Helm-managed `<release>-auth` Secret; Helm base64-encodes the values for you, which is useful when mounting extra secret-backed files via `archestra.extraVolumes`
- `archestra.envWithValueFrom` - Environment variables with `valueFrom` for Kubernetes downward API (`fieldRef`, `resourceFieldRef`) or other sources. Required for defining variables like `NODE_IP` that can be referenced via `$(NODE_IP)` in other env vars.
- `archestra.envFromSecrets` - Environment variables from Kubernetes Secrets (inject sensitive data from secrets)
- `archestra.envFrom` - Import all key-value pairs from Secrets or ConfigMaps as environment variables
- `archestra.extraVolumes` - Additional volumes for mounting extra files into the platform and worker pods
- `archestra.extraVolumeMounts` - Additional volume mounts for the platform and worker containers (for example, a Vertex AI service account key file)

**Auth secret configuration**: `ARCHESTRA_AUTH_SECRET` is optional. If you do not configure it, the Helm chart creates a `<release>-auth` Secret and auto-generates a 64-character `auth-secret` value on first install.

If you manage secrets outside Helm, point the chart at an existing Kubernetes Secret:

```yaml
archestra:
  authSecret:
    existingSecretName: archestra-auth
    existingSecretKey: auth-secret
```

If you use the Helm-managed `<release>-auth` Secret, you can also add extra keys to it and mount them as files from `archestra.extraVolumes`:

```yaml
archestra:
  authSecret:
    extraData:
      service-account.json: |
        {"type":"service_account"}
  extraVolumes:
    - name: platform-auth-secret
      secret:
        secretName: <release>-auth
        items:
          - key: service-account.json
            path: service-account.json
```

```bash
# Generate a secure secret
openssl rand -base64 32

# Then add to your helm command:
--set archestra.env.ARCHESTRA_AUTH_SECRET=<your-generated-secret>
```

#### Diagnostics Storage

To persist Node fatal error reports from the backend, enable chart-managed diagnostics storage. This mounts a persistent volume at `/var/diagnostics` in both the platform and worker pods and configures the backend to write diagnostic reports there automatically.

```yaml
archestra:
  diagnostics:
    enabled: true
    size: 10Gi
    storageClassName: standard-rwo
    accessModes:
      - ReadWriteOnce
```

Available values:

- `archestra.diagnostics.enabled` - Enable diagnostics storage for backend reports
- `archestra.diagnostics.existingClaimName` - Use an existing PVC instead of creating one
- `archestra.diagnostics.storageClassName` - StorageClass for the chart-managed PVC
- `archestra.diagnostics.size` - PVC storage request
- `archestra.diagnostics.accessModes` - PVC access modes
- `archestra.diagnostics.heapSnapshotsNearHeapLimit` - Optional Node heap snapshot count for near-OOM investigations

If you run both the platform and worker pods and want them to write to the same claim concurrently, choose a storage class and access mode combination your cluster supports for that pattern.

Chart-managed diagnostics PVCs are validated conservatively. If more than one diagnostics-writing pod can run at the same time, including during rolling updates, the chart requires `ReadWriteMany`. A single `ReadWriteOnce` claim is only safe for single-pod deployments with non-overlapping updates.

#### MCP Server Runtime Configuration

**Orchestrator Settings**:

- `archestra.orchestrator.baseImage` - Base Docker image for MCP server containers (defaults to official Archestra MCP server base image)

**Kubernetes Settings**:

- `archestra.orchestrator.kubernetes.namespace` - Kubernetes namespace where MCP server pods will be created (defaults to Helm release namespace)
- `archestra.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster` - Use in-cluster configuration (recommended when running inside K8s)
- `archestra.orchestrator.kubernetes.clusterDomain` - Kubernetes cluster DNS domain for internal service URL construction (default: cluster.local)
- `archestra.orchestrator.kubernetes.kubeconfig.enabled` - Enable mounting kubeconfig from a secret
- `archestra.orchestrator.kubernetes.kubeconfig.secretName` - Name of secret containing kubeconfig file
- `archestra.orchestrator.kubernetes.kubeconfig.mountPath` - Path where kubeconfig will be mounted
- `archestra.orchestrator.kubernetes.serviceAccount.create` - Create a service account (default: true)
- `archestra.orchestrator.kubernetes.serviceAccount.annotations` - Annotations for cloud integrations (e.g., [GKE Workload Identity](/docs/platform-supported-llm-providers#gke-with-workload-identity-recommended), AWS IRSA)
- `archestra.orchestrator.kubernetes.serviceAccount.name` - Name of the service account (auto-generated if not set)
- `archestra.orchestrator.kubernetes.serviceAccount.imagePullSecrets` - Image pull secrets for the service account
- `archestra.orchestrator.kubernetes.rbac.create` - Create RBAC resources (default: true)
- `archestra.orchestrator.kubernetes.networkPolicy.create` - Create a `NetworkPolicy` for SSRF protection on MCP server pods (default: false). Blocks egress to private/internal IP ranges (RFC 1918, link-local, loopback) while allowing DNS and public internet access. Requires a CNI plugin that supports `NetworkPolicies` (e.g., Calico, Cilium). See [SSRF Protection](#ssrf-protection-for-mcp-server-pods) for details.
- `archestra.orchestrator.kubernetes.networkPolicy.additionalDeniedCidrs` - Additional CIDR ranges to block beyond the defaults
- `archestra.orchestrator.kubernetes.networkPolicy.additionalEgressRules` - Additional egress rules to allow MCP server pods to reach specific internal services that would otherwise be blocked
- `archestra.orchestrator.kubernetes.mcpServerRbac.create` - Create MCP server RBAC resources (ServiceAccount, Role, RoleBinding) for Kubernetes MCP server (default: true)
- `archestra.orchestrator.kubernetes.mcpServerRbac.additionalClusterRoleBindings` - Additional ClusterRoleBindings to attach to the MCP K8s operator service account for cluster-wide permissions
- `archestra.orchestrator.kubernetes.mcpServerRbac.additionalRoleBindings` - Additional RoleBindings to attach to the MCP K8s operator service account for namespace-scoped permissions

#### Service, Deployment, & Ingress Configuration

**Deployment Settings**:

- `archestra.podAnnotations` - Annotations to add to pods (useful for Prometheus, Vault agent, service mesh sidecars, etc.)
- `archestra.nodeSelector` - Node selector for scheduling pods on specific nodes (e.g., specific node pools or instance types). These values are also inherited by MCP server pods as defaults.
- `archestra.tolerations` - Tolerations for scheduling pods on nodes with specific taints (e.g., dedicated nodes, GPU nodes, spot instances). These values are also inherited by MCP server pods as defaults. See [Kubernetes docs](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- `archestra.deploymentStrategy` - Deployment strategy configuration (default: RollingUpdate with `maxUnavailable: 25%` and `maxSurge: 25%`)
- `archestra.resources` - CPU and memory requests/limits for the container (default: 2Gi request, 3Gi limit for memory)

**Service Settings**:

- `archestra.service.type` - Service type: ClusterIP, NodePort, or LoadBalancer (default: ClusterIP)
- `archestra.service.annotations` - Annotations to add to the Kubernetes Service for cloud provider integrations
- `archestra.service.nodePorts` - Node ports for NodePort service type (backend, metrics, frontend)

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

**PodDisruptionBudget Settings**:

- `archestra.podDisruptionBudget.enabled` - Enable or disable PodDisruptionBudget creation (default: false)
- `archestra.podDisruptionBudget.minAvailable` - Minimum number of pods that must remain available (integer or percentage)
- `archestra.podDisruptionBudget.maxUnavailable` - Maximum number of pods that can be unavailable (integer or percentage)
- `archestra.podDisruptionBudget.unhealthyPodEvictionPolicy` - Policy for evicting unhealthy pods (IfHealthyBudget or AlwaysAllow)

**Note**: Only one of `minAvailable` or `maxUnavailable` can be set.

See the Kubernetes documentation for more details:

- [HorizontalPodAutoscaler](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [PodDisruptionBudget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)

#### Background Worker Configuration

The Helm chart deploys a separate worker `Deployment` for processing background jobs from the postgres queue. When enabled, the main platform pods run as web-only and the worker pods handle all background job processing.

**Worker Settings**:

- `archestra.worker.enabled` - Deploy a separate worker Deployment (default: true)
- `archestra.worker.replicaCount` - Number of worker pod replicas (default: 1)
- `archestra.worker.resources` - Resource requests/limits for worker pods (default: 1Gi request, 2Gi limit)
- `archestra.worker.deploymentStrategy` - Deployment strategy (default: RollingUpdate with `maxUnavailable: 25%` and `maxSurge: 25%`)
- `archestra.worker.podAnnotations` - Pod annotations (inherits from `archestra.podAnnotations` if not set)
- `archestra.worker.nodeSelector` - Node selector (inherits from `archestra.nodeSelector` if not set)
- `archestra.worker.tolerations` - Tolerations (inherits from `archestra.tolerations` if not set)

When the worker is disabled (`archestra.worker.enabled: false`), background jobs run in-process within the main platform pods.

#### Database Configuration

**PostgreSQL Settings**:

- `postgresql.external_database_url` - External PostgreSQL connection string (recommended for production)
- `postgresql.enabled` - Whether to deploy a self-hosted PostgreSQL instance in your Kubernetes cluster (default: true)

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

#### SSRF Protection for MCP Server Pods

The Helm chart includes an optional Kubernetes `NetworkPolicy` that prevents MCP server pods from performing Server-Side Request Forgery (SSRF) attacks. When enabled, it blocks outbound connections to private/internal IP ranges while allowing DNS resolution and public internet access.

This policy is **disabled by default** to avoid breaking MCP servers that connect to internal Kubernetes services (e.g., `grafana.monitoring.svc.cluster.local`). If your MCP servers only need public internet access, enabling this policy is recommended.

To enable the policy:

```yaml
archestra:
  orchestrator:
    kubernetes:
      networkPolicy:
        create: true
```

**Blocked IPv4 ranges** (when enabled):

- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` - RFC 1918 private ranges (cluster pods, services, nodes)
- `169.254.0.0/16` - Link-local / cloud metadata endpoints (AWS IMDSv1, GCP, Azure)
- `100.64.0.0/10` - Carrier-grade NAT (RFC 6598)
- `127.0.0.0/8` - Loopback
- `0.0.0.0/32` - Treated as localhost by some HTTP libraries

**Blocked IPv6 ranges** (for dual-stack clusters):

- `::1/128` - IPv6 loopback
- `fc00::/7` - Unique local addresses (equivalent to RFC 1918)
- `fe80::/10` - Link-local

**Prerequisite**: Your cluster must use a CNI plugin that enforces `NetworkPolicies` (e.g., Calico, Cilium). The default GKE CNI (kubenet) does **not** enforce `NetworkPolicies` unless Dataplane V2 or Calico is enabled.

MCP servers that need to connect to internal Kubernetes services will be blocked when this policy is enabled because ClusterIPs fall within the denied private ranges. Use `additionalEgressRules` to whitelist specific internal services.

By pod/namespace labels (recommended — survives IP changes):

```yaml
archestra:
  orchestrator:
    kubernetes:
      networkPolicy:
        additionalEgressRules:
          - to:
              - namespaceSelector:
                  matchLabels:
                    kubernetes.io/metadata.name: monitoring
                podSelector:
                  matchLabels:
                    app: grafana
            ports:
              - protocol: TCP
                port: 3000
```

By IP CIDR:

```yaml
archestra:
  orchestrator:
    kubernetes:
      networkPolicy:
        additionalEgressRules:
          - to:
              - ipBlock:
                  cidr: 10.0.50.0/24
            ports:
              - protocol: TCP
                port: 443
```

To block additional CIDR ranges beyond the defaults:

```yaml
archestra:
  orchestrator:
    kubernetes:
      networkPolicy:
        additionalDeniedCidrs:
          - 198.51.100.0/24
```

### Accessing the Platform

After installation, access the platform using port forwarding:

```bash
# Forward the API (port 9000) and Admin UI (port 3000)
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

##### pgvector Extension (Knowledge Base Feature)

The [Knowledge Base](/docs/platform-knowledge-bases) enterprise feature requires the [pgvector](https://github.com/pgvector/pgvector) PostgreSQL extension for vector similarity search. The database user specified in `ARCHESTRA_DATABASE_URL` must have permission to run `CREATE EXTENSION vector`, which typically requires **superuser** privileges.

**Cloud-managed databases:**

- **AWS RDS** — pgvector is available but is [not a trusted extension](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.Extensions.html#PostgreSQL.Concepts.General.Extensions.Trusted), so it must be installed by a user with the `rds_superuser` role. Connect as the RDS master user and run `CREATE EXTENSION vector`.
- **Google Cloud SQL** — pgvector is [supported natively](https://cloud.google.com/sql/docs/postgres/extensions#pgvector). Enable it via the Cloud SQL console or `CREATE EXTENSION vector`.
- **Azure Database for PostgreSQL** — pgvector is [available as an extension](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-extensions). Allow-list it in server parameters, then run `CREATE EXTENSION vector`.

**Self-managed PostgreSQL:** Install the pgvector package for your distribution (e.g., `apt install postgresql-17-pgvector`) and ensure the database user has `CREATE` privilege on the database, or grant `SUPERUSER` to allow extension creation.

If pgvector is not installed or the database user lacks permissions, the Knowledge Base migration will fail. This does not affect other Archestra features.

#### SSRF Protection

Enable the SSRF protection `NetworkPolicy` to prevent MCP server pods from accessing private/internal networks. This is especially important when MCP servers execute untrusted code or connect to external services. See [SSRF Protection for MCP Server Pods](#ssrf-protection-for-mcp-server-pods) for configuration details.

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

You can also set these values via environment variables instead of hardcoding them:

```bash
export ARCHESTRA_API_KEY="your-api-key-here"
export ARCHESTRA_BASE_URL="https://api.archestra.example.com"
```

For complete documentation, examples, and resource reference, visit the [Archestra Terraform Provider Documentation](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs).

## Environment Variables

The following environment variables can be used to configure Archestra Platform.

### Application & API Configuration

- **`ARCHESTRA_DATABASE_URL`** - PostgreSQL connection string for the database.
  - Format: `postgresql://user:password@host:5432/database`
  - Default: Internal PostgreSQL (Docker) or managed instance (Helm)
  - Required for production deployments with external database

- **`ARCHESTRA_API_BASE_URL`** - Archestra API Base URL(s) for connecting to Archestra's LLM Proxy, MCP Gateway and A2A Gateway.

  This URL is displayed in the UI connection instructions to help users configure their agents. It doesn\'t affect internal routing (Archestra frontend communicates with backend via `http://localhost:9000`).
  - Default: Falls back to `http://localhost:9000`
  - Supports multiple comma-separated URLs for different connection options (e.g., internal K8s URL and external ingress)
  - Single URL example: `https://api.archestra.com`
  - Multiple URLs example: `http://archestra.default.svc:9000,https://api.archestra.example.com`
  - Use case: Set this when your external access URL differs from the internal service URL (common in Kubernetes with ingress/load balancers)

- **`ARCHESTRA_TRUST_PROXY`** - Set this when Archestra runs behind a TLS-terminating reverse proxy (e.g. AWS ALB, nginx, Cloudflare) so that generated OAuth metadata and auth URLs use the external `https://` scheme rather than the internal `http://` scheme seen by the backend.
  - Default: `false` (no proxy trust)
  - Values: `true`, `false`, or a comma-separated list of trusted proxy IPs/CIDRs (e.g. `10.0.0.0/8,172.16.0.0/12`)
  - Example: `ARCHESTRA_TRUST_PROXY=true`

- **`ARCHESTRA_API_BODY_LIMIT`** - Maximum request body size for LLM proxy and chat routes.
  - Default: `50MB` (52428800 bytes)
  - Format: Numeric bytes (e.g., `52428800`) or human-readable (e.g., `50MB`, `100KB`, `1GB`)
  - Note: Increase this if you have conversations with very large context windows (100k+ tokens) or large file attachments in chat

- **`ARCHESTRA_FRONTEND_URL`** - Setting this variable enables origin validation for CORS and authentication. When set, only requests from this origin (and any in `ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS`) are allowed. When not set, all origins are accepted.
  - Example: `https://frontend.example.com`
  - Highly recommended for production.
  - If users access the platform via a LAN IP (e.g., `http://192.168.1.5:3000`), set this to that URL

- **`ARCHESTRA_MCP_SANDBOX_DOMAIN`** - Wildcard domain for MCP App sandbox isolation. Gives each MCP server a unique subdomain origin, enabling localStorage, CORS, and OAuth for MCP Apps. Not needed for local development (automatic localhost swap provides isolation).
  - Example: `mcp.example.com`
  - Requires wildcard DNS (`*.mcp.example.com`) and wildcard TLS certificate pointing to the backend
  - See [MCP Apps Sandbox](#mcp-apps-sandbox) for setup instructions

- **`ARCHESTRA_GLOBAL_TOOL_POLICY`** - Controls how tool invocation is treated across the LLM proxy.
  - Default: `permissive`
  - Values: `permissive` or `restrictive`
  - `permissive`: Tools are allowed, unless a specific policy is set for them.
  - `restrictive`: Tools are forbidden, unless a specific policy is set for them.

- **`ARCHESTRA_ANALYTICS`** - Controls PostHog analytics for product improvements.
  - Default: `enabled`
  - Set to `disabled` to opt-out of analytics

- **`ARCHESTRA_LOGGING_LEVEL`** - Log level for Archestra
  - Default: `info`
  - Supported values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`

### Authentication & Security

- **`ARCHESTRA_AUTH_SECRET`** - Secret key used for signing authentication tokens, encrypting secrets stored in the database, and encrypting JWKS private keys.
  - Auto-generated once on first run. Set manually if you need to control the secret value. Must be at least 32 characters long.
  - Example: `something-really-really-secret-12345`
  - **Warning:** Do not change this value after deployment. Rotating this secret will invalidate all user sessions (forcing re-login), make existing encrypted secrets unreadable, break JWT signing (JWKS private keys are encrypted with this secret), and break two-factor authentication for enrolled users.

- **`ARCHESTRA_AUTH_ADMIN_EMAIL`** - Email address for the default Archestra Admin user, created on startup.
  - Default: `admin@localhost.ai`

- **`ARCHESTRA_AUTH_ADMIN_PASSWORD`** - Password for the default Archestra Admin user. Set once on first-run.
  - Default: `password`
  - Note: Change this to a secure password for production deployments

- **`ARCHESTRA_AUTH_COOKIE_DOMAIN`** - Cookie domain configuration for authentication.
  - Should be set to the domain of the `ARCHESTRA_FRONTEND_URL`
  - Example: If frontend is at `https://frontend.example.com`, set to `example.com`
  - Required when using different domains or subdomains for frontend and backend

- **`ARCHESTRA_AUTH_DISABLE_BASIC_AUTH`** - Hides the username/password login form on the sign-in page.
  - Default: `false`
  - Set to `true` to disable basic authentication and require users to authenticate via SSO only
  - Note: Configure at least one Identity Provider before enabling this option. See [Identity Providers](/docs/platform-identity-providers) for SSO configuration.

- **`ARCHESTRA_AUTH_DISABLE_INVITATIONS`** - Disables user invitations functionality.
  - Default: `false`
  - Set to `true` to hide invitation-related UI and block invitation API endpoints
  - When enabled, administrators cannot create new invitations, and the invitation management UI is hidden
  - Useful for environments where user provisioning is handled externally (e.g., via SSO with automatic provisioning)

- **`ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS`** - Extra trusted origins for CORS and authentication, in addition to `ARCHESTRA_FRONTEND_URL`. Setting this variable (even without `ARCHESTRA_FRONTEND_URL`) enables origin validation.
  - Default: None (origin validation is off when neither this nor `ARCHESTRA_FRONTEND_URL` is set)
  - Format: Comma-separated list of origins (e.g., `http://idp.example.com:8080,https://auth.example.com`)
  - Use this to trust external identity providers (IdPs) for SSO, or to allow access from multiple URLs (e.g., both a LAN IP and a domain name)
  - Example for LAN access alongside localhost: `http://192.168.1.5:3000,http://192.168.1.5:9000`

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

- **`ARCHESTRA_DATABASE_URL_VAULT_REF`** - Read the database connection string from Vault instead of environment variables.
  - Optional: Only used when `ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT`
  - Format: `path:key` where `path` is the Vault secret path and `key` is the field containing the database URL
  - KV v2 example: `secret/data/archestra/database:connection_string`
  - KV v1 example: `secret/archestra/database:connection_string`

### LLM Provider Configuration

These environment variables set the default base URL for each LLM provider. Per-key base URLs configured in **Settings > LLM API Keys** take precedence over these defaults. See [LLM Proxy Authentication](/docs/platform-llm-proxy-authentication) for details on per-key base URLs and virtual API keys.

- **`ARCHESTRA_AI_BASE_URL`** - Override the OpenAI API base URL.
  - Default: `https://api.openai.com/v1`
  - Use this to point to your own proxy, an OpenAI-compatible API, or other custom endpoints

- **`ARCHESTRA_ANTHROPIC_BASE_URL`** - Override the Anthropic API base URL.
  - Default: `https://api.anthropic.com`
  - Use this to point to your own proxy or other custom endpoints

- **`ARCHESTRA_GEMINI_BASE_URL`** - Override the Google Gemini API base URL.
  - Default: `https://generativelanguage.googleapis.com`
  - Use this to point to your own proxy or other custom endpoints
  - Note: This is only used when Vertex AI mode is disabled

- **`ARCHESTRA_GROQ_BASE_URL`** - Override the Groq API base URL.
  - Default: `https://api.groq.com/openai/v1`
  - Use this to point to your own proxy, a Groq-compatible API, or other custom endpoints

- **`ARCHESTRA_XAI_BASE_URL`** - Override xAI API base URL.
  - Default: `https://api.x.ai/v1`
  - Use this to point to your own proxy or other custom endpoints

- **`ARCHESTRA_OPENROUTER_BASE_URL`** - Override OpenRouter API base URL.
  - Default: `https://openrouter.ai/api/v1`
  - Use this to point to your own proxy, an OpenRouter-compatible API, or other custom endpoints

- **`ARCHESTRA_VLLM_BASE_URL`** - Base URL for your vLLM server.
  - Required to enable vLLM provider support
  - Example: `http://localhost:8000/v1` (standard vLLM)
  - See: [vLLM setup guide](/docs/platform-supported-llm-providers#vllm)

- **`ARCHESTRA_OLLAMA_BASE_URL`** - Base URL for your Ollama server.
  - Default: `http://localhost:11434/v1` (Ollama is enabled by default)
  - Set this to override the default if your Ollama server runs on a different host or port
  - See: [Ollama setup guide](/docs/platform-supported-llm-providers#ollama)

- **`ARCHESTRA_DEEPSEEK_BASE_URL`** - Override the DeepSeek API base URL.
  - Default: `https://api.deepseek.com`
  - Use this to point to your own proxy or other custom endpoints

- **`ARCHESTRA_MINIMAX_BASE_URL`** - Override the MiniMax API base URL.
  - Default: `https://api.minimax.io/v1`
  - Use this to point to your own proxy or other custom endpoints

- **`ARCHESTRA_LLM_PROXY_MAX_VIRTUAL_KEYS`** - Maximum number of virtual API keys per LLM API key.
  - Default: `10`
  - Virtual keys are `archestra_`-prefixed tokens used by external LLM Proxy clients
  - See: [LLM Proxy Authentication](/docs/platform-llm-proxy-authentication)

- **`ARCHESTRA_LLM_PROXY_VIRTUAL_KEYS_DEFAULT_EXPIRATION_SECONDS`** - Default expiration time for newly created virtual API keys, in seconds.
  - Default: `2592000` (30 days)
  - Set to `0` to create virtual keys that never expire by default
  - Users can override this per-key when creating virtual keys via the UI

- **`ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED`** - Enable AWS IAM authentication for Bedrock.
  - Default: `false`
  - Set to `true` to use the AWS credential chain (IRSA, instance profiles, env vars) instead of API keys
  - See: [Bedrock IAM setup guide](/docs/platform-supported-llm-providers#iam-authentication-setup-irsa)

- **`ARCHESTRA_BEDROCK_REGION`** - Explicit AWS region for Bedrock.
  - Optional: Falls back to extracting from `ARCHESTRA_BEDROCK_BASE_URL`
  - Example: `us-east-1`

- **`ARCHESTRA_BEDROCK_ALLOWED_PROVIDERS`** - Filter Bedrock inference profiles by provider.
  - Optional: When empty, all inference profiles are returned
  - Comma-separated list of provider prefixes (e.g., `anthropic,amazon`)
  - See: [Filtering Models by Provider](/docs/platform-supported-llm-providers#filtering-models-by-provider)

- **`ARCHESTRA_BEDROCK_ALLOWED_INFERENCE_REGIONS`** - Filter Bedrock inference profiles by region.
  - Optional: When empty, all inference regions are returned
  - Comma-separated list of region prefixes (e.g., `us,global`)
  - See: [Filtering Models by Inference Region](/docs/platform-supported-llm-providers#filtering-models-by-inference-region)

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
  - In our testing, `us-central1` and `global` returned the most reliable Gemini publisher model listings. Some regions, including `us-east1`, may return incomplete model catalogs from Vertex AI model discovery APIs.

- **`ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE`** - Path to Google Cloud service account JSON key file.
  - Optional: Only needed when running outside of GCP or without Workload Identity
  - Example: `/path/to/service-account-key.json`
  - When not set, uses [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials)
  - See: [Vertex AI setup guide](/docs/platform-supported-llm-providers#using-vertex-ai)

- **`ARCHESTRA_CHAT_<PROVIDER>_API_KEY`** - LLM provider API keys for the built-in Chat feature.
  - Supported `<PROVIDER>` values: `ANTHROPIC`, `OPENAI`, `OPENROUTER`, `GEMINI`, `CEREBRAS`, `COHERE`, `GROQ`, `XAI`, `MISTRAL`, `PERPLEXITY`, `VLLM`, `OLLAMA`, `ZHIPUAI`, `DEEPSEEK`, `BEDROCK`, `MINIMAX`
  - These serve as fallback API keys when no organization default or profile-specific key is configured
  - Note: `ARCHESTRA_CHAT_VLLM_API_KEY` and `ARCHESTRA_CHAT_OLLAMA_API_KEY` are optional as most vLLM/Ollama deployments don't require authentication
  - See [Chat](/docs/platform-chat) for full details on API key configuration and resolution order

- **`ARCHESTRA_CHAT_DEFAULT_PROVIDER`** - Default LLM provider for Chat and A2A features.
  - Default: `anthropic`
  - Options: `anthropic`, `openai`, `gemini`
  - Used when no profile-specific provider is configured

### MCP Apps Sandbox

MCP Apps run inside sandboxed iframes with cross-origin isolation, CSP enforcement, and a double-iframe architecture. The sandbox proxy is served from the main backend under `/_sandbox/` — no separate port or service is needed.

#### How It Works by Environment

| Environment | Isolation method | Config needed | MCP App capabilities |
|---|---|---|---|
| **Local dev / Quickstart** (`localhost`) | `localhost` ↔ `127.0.0.1` origin swap (same port, different origin) | None | Full (localStorage, CORS, etc.) |
| **Production with sandbox domain** | Dedicated subdomain per MCP server | `ARCHESTRA_MCP_SANDBOX_DOMAIN` + wildcard DNS/TLS | Full |
| **Production without sandbox domain** | Opaque origin (iframe `sandbox` attribute) | None | Limited (no localStorage, no origin-restricted CORS) |

**Local development and Quickstart** work out of the box with no configuration. The platform automatically swaps `localhost` to `127.0.0.1` (or vice versa) to create a different origin on the same port. This gives MCP Apps full browser API access while maintaining security isolation.

**Production deployments** can optionally configure `ARCHESTRA_MCP_SANDBOX_DOMAIN` for full MCP App functionality. Without it, MCP Apps still render and function, but cannot use `localStorage`, cookies, or APIs that check `Access-Control-Allow-Origin` against a specific origin. Most MCP Apps work fine without it.

#### Configuring a Sandbox Domain (Production)

Set `ARCHESTRA_MCP_SANDBOX_DOMAIN` when MCP Apps need persistent state or origin-restricted API access.

1. Choose a subdomain for the sandbox (e.g., `mcp.example.com`)

2. Create a **wildcard DNS record**:
   ```
   *.mcp.example.com → <backend IP or load balancer>
   ```

3. Obtain a **wildcard TLS certificate** for `*.mcp.example.com` (e.g., via Let's Encrypt DNS challenge, or your CA)

4. Configure the reverse proxy (nginx, Caddy, etc.) to route `*.mcp.example.com` to the backend (port 9000), applying the wildcard certificate

5. Set the environment variable:
   ```yaml
   ARCHESTRA_MCP_SANDBOX_DOMAIN: mcp.example.com
   ```

Each MCP server automatically gets a unique hash-based subdomain (e.g., `a1b2c3d4.mcp.example.com`). The backend validates the `Host` header on sandbox requests to prevent abuse.

#### Origin Restrictions

The sandbox inherits origin restrictions from `ARCHESTRA_FRONTEND_URL` and `ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS` (the same variables that control CORS). When set, only those origins can embed the sandbox iframe. When neither is set (local dev), all origins are accepted.

### MCP Server Orchestrator

- **`ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE`** - Kubernetes namespace to run MCP server pods.
  - Default: Helm release namespace (if relevant) or `default`
  - Example: `archestra-mcp` or `production`

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE`** - Base Docker image for MCP servers.
  - Default: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.3`
  - Can be overridden per individual MCP server.

- **`ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER`** - Use in-cluster config when running inside Kubernetes.
  - Default: `true`
  - Set to `false` when Archestra is deployed in the different cluster and specify the `ARCHESTRA_ORCHESTRATOR_KUBECONFIG`.

- **`ARCHESTRA_ORCHESTRATOR_KUBECONFIG`** - Path to the custom kubeconfig file to mount as a volume inside the container.
  - Optional: Uses default locations if not specified
  - Example: `/path/to/kubeconfig`

### Observability & Metrics

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT`** - OTEL Exporter endpoint for sending traces.
  - Default: `http://localhost:4318/v1/traces`

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME`** - Username for OTEL basic authentication.
  - Optional: Only used if both username and password are provided
  - Example: `your-username`

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD`** - Password for OTEL basic authentication.
  - Optional: Only used if both username and password are provided
  - Example: `your-password`

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER`** - Bearer token for OTEL authentication.
  - Optional: Takes precedence over basic authentication if provided
  - Example: `your-bearer-token`

- **`ARCHESTRA_OTEL_CAPTURE_CONTENT`** - Enable or disable prompt/completion content capture in trace spans.
  - Default: `true` (enabled)
  - Set to `false` to disable content capture for privacy or to reduce span sizes

- **`ARCHESTRA_OTEL_CONTENT_MAX_LENGTH`** - Maximum character length for captured content in span events (prompt messages, completions, tool arguments, tool results).
  - Default: `10000` (10,000 characters)
  - Content exceeding this limit is truncated with a `...[truncated]` suffix
  - Only applies when `ARCHESTRA_OTEL_CAPTURE_CONTENT` is enabled

- **`ARCHESTRA_OTEL_VERBOSE_TRACING`** - Enable verbose infrastructure spans (HTTP routes, outgoing HTTP calls, Node.js fetch, etc).
  - Default: `false` (disabled)
  - When disabled, traces only contain GenAI-specific spans (LLM calls, MCP tool calls) for a clean, focused view
  - Set to `true` to include infrastructure spans for debugging request flows

- **`ARCHESTRA_METRICS_SECRET`** - Bearer token for authenticating metrics endpoint access.
  - Default: `archestra-metrics-secret`
  - Note: When set, clients must include `Authorization: Bearer <token>` header to access `/metrics`

### Incoming Email Configuration

These environment variables configure the Incoming Email feature, which allows external users to invoke agents by sending emails. See [Incoming Email](/docs/platform-agent-triggers-email) for setup instructions.

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER`** - Email provider to use for incoming email.
  - Default: Not set (feature disabled)
  - Options: `outlook`
  - Required to enable the incoming email feature

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_TENANT_ID`** - Azure AD tenant ID for Microsoft Graph API.
  - Required when: `ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER=outlook`
  - Example: `eeeee123-2205-4e2f-afb6-f83e5f588f40`

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_CLIENT_ID`** - Azure AD application (client) ID.
  - Required when: `ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER=outlook`
  - Example: `88888dd-d6a1-4fd6-8783-b2f4931be17b`

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_CLIENT_SECRET`** - Azure AD application client secret.
  - Required when: `ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER=outlook`
  - Note: Keep this value secure; do not commit to version control

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_MAILBOX_ADDRESS`** - Email address of the mailbox to monitor.
  - Required when: `ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER=outlook`
  - Example: `agents@yourcompany.com`
  - This mailbox receives all agent-bound emails via plus-addressing

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_EMAIL_DOMAIN`** - Override the email domain for agent addresses.
  - Optional: Defaults to domain extracted from `ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_MAILBOX_ADDRESS`
  - Example: `yourcompany.com`

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_WEBHOOK_URL`** - Public webhook URL for Microsoft Graph notifications.
  - Optional: If set, subscription is created automatically on server startup
  - Example: `https://api.yourcompany.com/api/webhooks/incoming-email`
  - If not set, configure the subscription manually via Settings > Incoming Email

### ChatOps Configuration

These environment variables configure the ChatOps feature, which allows users to interact with agents through messaging platforms like Microsoft Teams. See [Agents - ChatOps: Microsoft Teams](/docs/platform-agents#chatops-microsoft-teams) for setup instructions.

#### Microsoft Teams

- **`ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED`** - Enable Microsoft Teams integration.
  - Default: `false`
  - Set to `true` to enable the MS Teams chatops provider

- **`ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID`** - Azure Bot App ID (Client ID).
  - Required when: `ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true`
  - Example: `88888dd-d6a1-4fd6-8783-b2f4931be17b`
  - This is the Application (client) ID from your Azure Bot registration

- **`ARCHESTRA_CHATOPS_MS_TEAMS_APP_PASSWORD`** - Azure Bot App Password (Client Secret).
  - Required when: `ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true`
  - Note: Keep this value secure; do not commit to version control
  - This is the client secret from your Azure Bot registration

- **`ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID`** - Azure AD tenant ID for single-tenant bots.
  - Optional: Leave empty for multi-tenant bots (default)
  - Set to your Azure AD tenant ID if your Azure Bot is configured as single-tenant
  - Example: `eeeee123-2205-4e2f-afb6-f83e5f588f40`
  - Find in Azure Portal: Azure Bot → Configuration → Microsoft App ID (tenant) or Azure AD → Overview → Tenant ID

- **`ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_TENANT_ID`** - Azure AD tenant ID for Microsoft Graph API (thread history).
  - Optional: Only required if you want to fetch conversation history for context
  - Example: `eeeee123-2205-4e2f-afb6-f83e5f588f40`

- **`ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_ID`** - Azure AD application (client) ID for Graph API.
  - Optional: Only required if you want to fetch conversation history for context
  - Can be the same as `ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID` if using the same app registration

- **`ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_SECRET`** - Azure AD application client secret for Graph API.
  - Optional: Only required if you want to fetch conversation history for context
  - Note: Keep this value secure; do not commit to version control

#### Slack

See [Slack](/docs/platform-slack) for setup instructions.

- **`ARCHESTRA_CHATOPS_SLACK_ENABLED`** - Enable Slack integration.
  - Default: `false`
  - Set to `true` to enable the Slack chatops provider

- **`ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN`** - Slack Bot User OAuth Token.
  - Required when: `ARCHESTRA_CHATOPS_SLACK_ENABLED=true`
  - Starts with `xoxb-`
  - Found in: OAuth & Permissions page → Bot User OAuth Token

- **`ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET`** - Slack app signing secret for webhook signature verification.
  - Required when: using webhook mode (default)
  - Found in: Basic Information page → App Credentials → Signing Secret

- **`ARCHESTRA_CHATOPS_SLACK_APP_ID`** - Slack App ID.
  - Optional but recommended for DM deep links
  - Found in: Basic Information page → App ID

- **`ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE`** - Connection mode for Slack integration.
  - Default: `socket`
  - Options: `socket`, `webhook`
  - `socket`: Archestra connects to Slack via an outbound WebSocket (no public URL required)
  - `webhook`: Slack sends events to your public webhook URLs (requires a publicly accessible Archestra instance)

- **`ARCHESTRA_CHATOPS_SLACK_APP_LEVEL_TOKEN`** - Slack App-Level Token for socket mode.
  - Required for the default socket mode
  - Starts with `xapp-`
  - Generated in: Basic Information page → App-Level Tokens (with `connections:write` scope)

### Knowledge Base Configuration

> **Enterprise feature:** Requires `ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED=true`. See [Enterprise Licensing](#enterprise-licensing) below.

These environment variables configure the [Knowledge Base](/docs/platform-knowledge-bases) enterprise feature. Knowledge bases use a built-in RAG stack powered by pgvector for document chunking, embedding, and hybrid search. Connectors sync external data into knowledge bases on a schedule. See [Knowledge Connectors](/docs/platform-adding-knowledge-connectors) for connector setup instructions.

- **Embedding and reranker API keys** are configured via LLM Provider Keys in **Settings > Knowledge**. No environment variable is needed — select an existing LLM Provider Key (OpenAI only for embeddings, any provider for the reranker). Both must be configured before knowledge bases and connectors can be used.

- **`ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_SYNC_MAX_DURATION_SECONDS`** - Maximum duration for a single connector sync run before it stops and triggers a continuation.
  - Default: `3300` (55 minutes)
  - Only applies to K8s CronJob runs. When a sync exceeds 90% of this budget, it stops and creates a continuation Job to resume from the last checkpoint.
  - Set to `0` to disable time-bounded runs.

- **`ARCHESTRA_KNOWLEDGE_BASE_HYBRID_SEARCH_ENABLED`** - Enable or disable hybrid search (combines vector similarity with full-text search using Reciprocal Rank Fusion).
  - Default: `true`
  - Set to `false` to use vector similarity search only.

### Enterprise Licensing

To learn more about enterprise licensing, please reach out to [sales@archestra.ai](mailto:sales@archestra.ai).

- **`ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED`** - Activates enterprise features in Archestra.
  - Set to `true` to enable the enterprise license
  - Required as a prerequisite for all other enterprise feature flags

- **`ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED`** - Enables the Knowledge Base enterprise feature.
  - Set to `true` to enable
  - Requires the core enterprise license (`ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED=true`)

- **`ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING`** - Enables full white-labeling (removes "Powered by Archestra" attribution).
  - Set to `true` to enable
  - Requires the core enterprise license (`ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED=true`)
