---
title: Deployment
category: Archestra Platform
order: 3
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
docker run -p 127.0.0.1:9000:9000 -p 127.0.0.1:3000:3000\
   -e ARCHESTRA_QUICKSTART=true \
   -v /var/run/docker.sock:/var/run/docker.sock \
   -v archestra-postgres-data:/var/lib/postgresql/data \
   -v archestra-app-data:/app/data \
   archestra/platform;
```

**Windows (PowerShell):**

```powershell
docker pull archestra/platform:latest;
docker run -p 127.0.0.1:9000:9000 -p 127.0.0.1:3000:3000`
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

> **Need access from another device on your network?** Replace `127.0.0.1:9000:9000` and `127.0.0.1:3000:3000` with `0.0.0.0:9000:9000` and `0.0.0.0:3000:3000` in the Docker command.
>
> This exposes the Admin UI and API to your local network. In quickstart mode, private network IPs (e.g., `192.168.x.x`, `10.x.x.x`) are automatically trusted, so authentication works without extra configuration.

If you have Kubernetes installed locally, you can use it for the MCP orchestrator. Make sure `kubectl` points to the right cluster and run the container without the socket and without `ARCHESTRA_QUICKSTART`. The orchestrator will create a cluster in the current context. See [Development with Standalone Kubernetes](./platform-orchestrator#local-development-with-docker-and-standalone-kubernetes)

```diff
docker run -p 127.0.0.1:9000:9000 -p 127.0.0.1:3000:3000\
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
docker run -p 127.0.0.1:9000:9000 -p 127.0.0.1:3000:3000 \
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

#### Init Container Configuration

Use the `archestra.initContainers` block to override the helper containers that prepare the platform pod before the main container starts.

Available values:

- `archestra.initContainers.busyboxImage` - Overrides the `wait-for-postgres` image. Use this when your cluster cannot pull from Docker Hub and you need to point at a private mirror.
- `archestra.initContainers.resources` - Applies Kubernetes resource requests and limits to the chart-managed init containers. This is useful on clusters that enforce `ResourceQuota` for init containers, such as OpenShift with restricted SCCs.

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
- `archestra.orchestrator.kubernetes.rbac.create` - Create RBAC resources for MCP workload management, including pods, services, secrets, deployments, and generated `NetworkPolicy` objects (default: true)
- `archestra.orchestrator.kubernetes.networkPolicy.create` - Create a `NetworkPolicy` for SSRF protection on MCP server pods (default: false). Blocks egress to private/internal IP ranges (RFC 1918, link-local, loopback) while allowing DNS and public internet access. Requires a CNI plugin that supports `NetworkPolicies` (e.g., Calico, Cilium). See [SSRF Protection](#ssrf-protection-for-mcp-server-pods) for details.
- `archestra.orchestrator.kubernetes.networkPolicy.additionalDeniedCidrs` - Additional CIDR ranges to block beyond the defaults
- `archestra.orchestrator.kubernetes.networkPolicy.additionalEgressRules` - Additional egress rules to allow MCP server pods to reach specific internal services that would otherwise be blocked

Environment network policies require the chart's default MCP manager RBAC so Archestra can create Kubernetes `NetworkPolicy` objects and any detected FQDN policy objects. See [Network Policies](/docs/platform-private-registry#network-policies).

- `archestra.orchestrator.kubernetes.mcpServerRbac.create` - Create MCP server RBAC resources (ServiceAccount, Role, RoleBinding) for Kubernetes MCP server (default: true)
- `archestra.orchestrator.kubernetes.mcpServerRbac.additionalClusterRoleBindings` - Additional ClusterRoleBindings to attach to the MCP K8s operator service account for cluster-wide permissions
- `archestra.orchestrator.kubernetes.mcpServerRbac.additionalRoleBindings` - Additional RoleBindings to attach to the MCP K8s operator service account for namespace-scoped permissions

#### Service, Deployment, & Ingress Configuration

**Deployment Settings**:

- `archestra.podAnnotations` - Annotations to add to pods (useful for Prometheus, Vault agent, service mesh sidecars, etc.)
- `archestra.podLabels` - Labels to add to pods (useful for AKS Microsoft Entra Workload ID)
- `archestra.nodeSelector` - Node selector for scheduling pods on specific nodes (e.g., specific node pools or instance types). These values are also inherited by MCP server pods as defaults.
- `archestra.tolerations` - Tolerations for scheduling pods on nodes with specific taints (e.g., dedicated nodes, GPU nodes, spot instances). These values are also inherited by MCP server pods as defaults. See [Kubernetes docs](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- `archestra.deploymentStrategy` - Deployment strategy configuration (default: RollingUpdate with `maxUnavailable: 25%` and `maxSurge: 25%`)
- `archestra.resources` - CPU and memory requests/limits for the container (default: 2 vCPU request, 2Gi memory request, 3Gi memory limit)
- `archestra.horizontalPodAutoscaler` - Optional HPA for the main `archestra-platform` Deployment. When enabled, the chart defaults to `minReplicas: 2`, `maxReplicas: 10`, a memory utilization target of 70%, immediate scale-up, and a 5-minute scale-down stabilization window.
- `archestra.worker.replicaCount` - Manual replica count for the separate worker Deployment
- `archestra.worker.resources` - Resource requests/limits for worker pods (default: 2 vCPU request, 1Gi memory request, 2Gi memory limit)
- `archestra.worker.deploymentStrategy` - Rolling update strategy for worker pods (default: `maxUnavailable: 25%`, `maxSurge: 25%`)
- `archestra.migrationJob.enabled` - Run database migrations in a pre-upgrade Job before rolling web and worker pods (default: true)
- `archestra.migrationJob.envFromSecrets` - Optional hook-only secret values, usually only needed when `ARCHESTRA_DATABASE_URL` uses Kubernetes `$(VAR)` expansion

#### HorizontalPodAutoscaler

The Helm chart can optionally create a Kubernetes `HorizontalPodAutoscaler` for the main `archestra-platform` Deployment. It does not autoscale the separate worker Deployment.

Default behavior when enabled:

- Maintains at least 2 web pods
- Scales up to 10 web pods
- Uses memory utilization as the default scaling signal
- Scales up aggressively (up to 100% or 2 pods per minute)
- Scales down conservatively with a 5-minute stabilization window

If you prefer CPU-driven scaling, override `archestra.horizontalPodAutoscaler.metrics` with a CPU target instead.

#### Existing Scaling Controls

The chart already exposes a few scaling-related controls, even without autoscaling:

- `archestra.replicaCount` sets the manual replica count for web pods when HPA is disabled
- `archestra.worker.replicaCount` sets the manual replica count for worker pods
- `archestra.deploymentStrategy` and `archestra.worker.deploymentStrategy` control rollout overlap (`maxSurge` and `maxUnavailable`), which affects rollout capacity but not steady-state scaling
- `archestra.podDisruptionBudget` protects availability during voluntary disruptions, but it is not an autoscaler

The chart does not currently create worker HPAs, KEDA `ScaledObject`s, or a VerticalPodAutoscaler.

#### Worker Scaling Recommendations

Worker throughput is driven by a Postgres-backed task queue, so resource-based autoscaling is usually the wrong first signal. The worker currently polls the `tasks` table for rows where `status = 'pending'` and `scheduled_for <= NOW()`, and each pod processes up to `ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_MAX_CONCURRENT` tasks at once (default: `2`).

Recommended approach:

- Keep the platform HPA focused on web traffic and leave workers on manual replicas until you have queue metrics
- Tune `archestra.worker.replicaCount` together with `ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_MAX_CONCURRENT`; increasing concurrency per pod is often cheaper than adding pods for modest backlog
- If you use KEDA, scale workers from queue backlog instead of CPU or memory

For KEDA-backed worker autoscaling, use KEDA's PostgreSQL scaler against the `tasks` table with a query that counts ready work, for example:

- `SELECT COUNT(*) FROM tasks WHERE status = 'pending' AND scheduled_for <= NOW()`

Practical starting point for worker autoscaling:

- Start with `minReplicaCount: 1`
- Set `activationQueryValue: "1"` so KEDA stays idle when there is no ready work
- With the default `ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_MAX_CONCURRENT=2`, start with `targetQueryValue: "4"` so each worker pod is asked to absorb about two waves of ready tasks before KEDA adds another pod
- Keep `maxReplicaCount` aligned with database capacity, embedding provider rate limits, and downstream connector quotas

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
- `archestra.worker.resources` - Resource requests/limits for worker pods (default: 2 vCPU request, 1Gi memory request, 2Gi memory limit)
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
  --set postgresql.enabled=false \
  --set postgresql.external_database_url=postgresql://user:password@host:5432/database \
  --wait
```

If you don't specify `postgresql.external_database_url`, the chart will deploy a managed PostgreSQL instance using the Bitnami PostgreSQL chart. For PostgreSQL-specific configuration options, see the [Bitnami PostgreSQL Helm chart documentation](https://artifacthub.io/packages/helm/bitnami/postgresql?modal=values-schema).

During Helm upgrades, the chart runs `pnpm db:migrate` in a pre-upgrade Job before rolling the web and worker Deployments. Disable `archestra.migrationJob.enabled` only if your deployment pipeline applies migrations out of band.

For external Postgres, the simplest setup is a complete `postgresql.external_database_url`; the chart stores it in a Kubernetes Secret and passes it to the migration Job automatically.

If your deployment intentionally keeps the password in a separate Secret and uses `ARCHESTRA_DATABASE_URL=postgresql://user:$(PGPASSWORD)@host:5432/database`, provide `PGPASSWORD` to the migration Job through chart values:

```yaml
archestra:
  migrationJob:
    envFromSecrets:
      - name: PGPASSWORD
        secretName: my-db-secret
        secretKey: password
```

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

Manage Archestra resources from Terraform or Crossplane. Both use the same API key — mint one under Settings → API Keys (see [API Reference](/docs/platform-api-reference#authentication)).

### Terraform

**1. Configure the provider.** Read credentials from the environment (`export ARCHESTRA_API_KEY=...` and `export ARCHESTRA_BASE_URL=...`) or pass them inline.

```terraform
terraform {
  required_providers {
    archestra = {
      source = "archestra-ai/archestra"
    }
  }
}

provider "archestra" {}
```

**2. Define a resource.** Register an MCP server in the catalog, then install it.

```terraform
resource "archestra_mcp_registry_catalog_item" "memory" {
  name        = "memory"
  description = "In-memory key-value store"

  local_config = {
    command   = "npx"
    arguments = ["-y", "@modelcontextprotocol/server-memory"]
  }
}

resource "archestra_mcp_server_installation" "memory" {
  name       = "memory"
  catalog_id = archestra_mcp_registry_catalog_item.memory.id
}
```

**3. Apply.**

```bash
terraform init
terraform apply
```

Full resource reference: [Terraform provider docs](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs).

### Crossplane

Crossplane v1 or v2 must already be installed in the target cluster.

**1. Install the provider.** Pin the latest tag from [GitHub Releases](https://github.com/archestra-ai/terraform-provider-archestra/releases).

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-archestra
spec:
  package: xpkg.upbound.io/archestra/provider-archestra:v1.1.4
```

**2. Configure credentials.**

```bash
kubectl create secret generic archestra-creds \
  -n crossplane-system \
  --from-literal=credentials='{"api_key":"arch_...","base_url":"https://api.archestra.example.com"}'
```

```yaml
apiVersion: archestra.crossplane.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: archestra-creds
      key: credentials
```

**3. Create a resource.** Mirror of the Terraform example above.

```yaml
apiVersion: mcp.archestra.crossplane.io/v1alpha1
kind: RegistryCatalogItem
metadata:
  name: memory
spec:
  forProvider:
    name: memory
    description: In-memory key-value store
    localConfig:
      command: npx
      arguments:
        - "-y"
        - "@modelcontextprotocol/server-memory"
  providerConfigRef:
    name: default
---
apiVersion: mcp.archestra.crossplane.io/v1alpha1
kind: ServerInstallation
metadata:
  name: memory
spec:
  forProvider:
    name: memory
    catalogIdRef:
      name: memory
  providerConfigRef:
    name: default
```

Full resource reference: [Crossplane provider README](https://github.com/archestra-ai/terraform-provider-archestra/blob/main/crossplane/README.md).

### Crossplane

The same resources are also available as a Crossplane v1/v2 provider for teams that prefer GitOps-style reconciliation on Kubernetes. The xpkg is [upjet](https://github.com/crossplane/upjet)-generated from the Terraform provider's schema and published from the same release tag, so the two stay version-locked.

**Install the provider**:

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-archestra
spec:
  package: xpkg.upbound.io/archestra/provider-archestra:v1.1.4
```

**Configure credentials** (the API key is the same one used by the Terraform provider — see [API Reference](/docs/platform-api-reference#authentication)):

```bash
kubectl create secret generic archestra-creds \
  -n crossplane-system \
  --from-literal=credentials='{"api_key":"arch_...","base_url":"https://api.archestra.example.com"}'
```

```yaml
apiVersion: archestra.crossplane.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: archestra-creds
      key: credentials
```

For supported resources, examples, and the contributor flow, see the [Crossplane provider README](https://github.com/archestra-ai/terraform-provider-archestra/blob/main/crossplane/README.md). Resource coverage is partial — current state and the gap vs. the Terraform provider are tracked on the [coverage badge](https://github.com/archestra-ai/terraform-provider-archestra#archestra-provider).

## Environment Variables

The following environment variables can be used to configure Archestra Platform.

### Application & API Configuration

- **`ARCHESTRA_DATABASE_URL`** - PostgreSQL connection string for the database.
  - Format: `postgresql://user:password@host:5432/database`
  - Default: Internal PostgreSQL (Docker) or managed instance (Helm)
  - Required for production deployments with external database

- **`ARCHESTRA_DATABASE_POOL_MAX`** - Maximum number of PostgreSQL connections per backend pod.
  - Default: `50`
  - Range: `1`–`500`
  - Tune this when you have many concurrent users or long-running chat streams. The backend opens at most `ARCHESTRA_DATABASE_POOL_MAX` connections per pod, so coordinate with PostgreSQL `max_connections` to ensure `pods × ARCHESTRA_DATABASE_POOL_MAX < max_connections` with headroom for admin sessions. On managed Postgres (e.g. AWS RDS, Cloud SQL) the server limit is typically several thousand and rarely the binding constraint.

- **`ARCHESTRA_DATABASE_STATEMENT_TIMEOUT_MILLIS`** - Per-connection PostgreSQL `statement_timeout` (in milliseconds) applied to every pooled connection.
  - Default: `30000` (30s)
  - Set to `0` to disable the timeout entirely.
  - Defense-in-depth against pathological queries: any statement running longer than this is cancelled by PostgreSQL so a single slow query can't hold a connection open indefinitely. Raise it if you have legitimate long-running analytical queries.

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

- **`ARCHESTRA_BETA`** - Master switch for ships-dark preview features. When `true`, every `ARCHESTRA_*_ENABLED` product-feature gate below defaults on at once — Agent Skills, Agent Environments, agent hooks, the code runtime, MCP Apps, and Projects. An explicit per-flag value always wins, so `ARCHESTRA_BETA=true` with `ARCHESTRA_APPS_ENABLED=false` keeps Apps off. Beta only flips intent — the sandbox and agent hooks still need a Dagger runner host to run. Does not touch credential/auth-mode toggles (e.g. Bedrock IAM, Azure/Vertex Entra), enterprise-licensed features, or always-on defaults (DCR, chat secret scanning, knowledge-base hybrid search).
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_AGENTS_SKILLS_ENABLED`** - Enables Agent Skills — reusable `SKILL.md` instruction sets that agents load on demand. When off, the Skills page and its sidebar link are hidden and the feature cannot be enabled for an organization.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_AGENTS_ENVIRONMENTS_ENABLED`** - Shows the per-environment sandbox binding selector on the agent form, letting an agent's code sandbox run on a deployment environment's dedicated Dagger engine under that environment's egress policy. When off, the selector is hidden. Requires the code runtime and Kubernetes.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_AGENT_HOOKS_ENABLED`** - Enables agent lifecycle hooks — user-defined scripts that run at chat lifecycle events (and the admin-only `/debug` chip mode in chat). Only takes effect when the agent runtime is also on (`ARCHESTRA_CODE_RUNTIME_ENABLED=true`), since hooks execute in the per-conversation sandbox. When off, the per-agent hooks editor is hidden and no hooks run.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_CODE_RUNTIME_BASE_PREBUILT`** - Set `true` only when `ARCHESTRA_DAGGER_RUNTIME_IMAGE` points at a pre-baked sandbox base image that already contains the apt toolbelt, the `uv` virtualenv, and the default Python dependencies. The runtime then skips the per-sandbox apt/`uv` build steps and instead verifies a provenance marker on the image — failing loudly if the image isn't the baked base — so an engine with restricted egress no longer needs to reach `ghcr.io`, the Debian mirrors, or PyPI when it materializes a sandbox; only the registry hosting the base image. Leave `false` (the default) to build the base from the stock runtime image on first use.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_APPS_ENABLED`** - Enables user-authored MCP Apps — apps created inside Archestra (from chat or the `/apps` page) with their own data store and assignable tools. When off, the `/apps` page and its sidebar link are hidden, the app tools and routes are not registered, and the feature cannot be used.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_GIT_BINARY_PATH`** - Path to the `git` binary. The public marketplace endpoint shells out to `git http-backend` (CGI) for clone/pull traffic — make sure the binary is present in the backend container image.
  - Default: `git`

- **`ARCHESTRA_SKILL_MARKETPLACE_CACHE_DIR`** - Directory holding materialized marketplace git repos. The cache is a derived view of the `skill_share_link_revision` history — replays are byte-identical, so wiping is safe but triggers a full rebuild on next clone. In prod, point this at a persistent volume to avoid the rebuild on container restarts.
  - Default: `~/.archestra/skill-marketplace-cache`

### My Files Storage

My Files is the persistent byte-storage layer used by Projects and the `search_files` / `save_result` tools. The active provider is selected at write time and stamped per row, so switching providers affects only new writes — existing files remain readable from their original backend.

- **`ARCHESTRA_FILE_STORAGE_PROVIDER`** - Storage backend for My Files.
  - Default: `db`
  - Options: `db` (Postgres bytea), `filesystem` (mounted volume / PVC), `s3` (S3-compatible object store)

- **`ARCHESTRA_FILE_STORAGE_FILESYSTEM_ROOT`** - Absolute path to the root directory for the `filesystem` provider (e.g. a PVC mount).
  - Required when: `ARCHESTRA_FILE_STORAGE_PROVIDER=filesystem`
  - Example: `/var/archestra/files`

- **`ARCHESTRA_FILE_STORAGE_S3_BUCKET`** - S3 bucket name for the `s3` provider.
  - Required when: `ARCHESTRA_FILE_STORAGE_PROVIDER=s3`
  - Example: `my-archestra-files`

- **`ARCHESTRA_FILE_STORAGE_S3_REGION`** - AWS region for the S3 bucket.
  - Default: `us-east-1`
  - Example: `eu-west-1`

- **`ARCHESTRA_FILE_STORAGE_S3_ENDPOINT`** - Custom endpoint URL for S3-compatible stores such as MinIO or Cloudflare R2.
  - Optional: Leave blank for standard AWS S3
  - Example: `http://minio:9000` (MinIO), `https://<account-id>.r2.cloudflarestorage.com` (R2)

- **`ARCHESTRA_FILE_STORAGE_S3_FORCE_PATH_STYLE`** - Use path-style addressing instead of virtual-hosted-style.
  - Required for MinIO: set to `true`
  - Default: `false` (virtual-hosted style, correct for AWS S3 and most S3-compatible stores)

- **`ARCHESTRA_FILE_STORAGE_S3_ACCESS_KEY_ID`** and **`ARCHESTRA_FILE_STORAGE_S3_SECRET_ACCESS_KEY`** - Static AWS credentials for the S3 provider.
  - Optional: When both are omitted, the AWS default credential chain is used (environment variables, `~/.aws/credentials`, IAM instance profile, IRSA, etc.)
  - Use static credentials for self-hosted stores (MinIO) or when running outside AWS without IRSA

- **`ARCHESTRA_FILE_STORAGE_S3_KEY_PREFIX`** - Optional object key prefix (folder) within the bucket.
  - Optional: Leave blank to write objects at the bucket root
  - Useful for sharing one bucket across multiple Archestra instances (e.g. `staging/` vs `production/`)
  - Example: `archestra-prod/`

- **`ARCHESTRA_ANALYTICS`** - Controls PostHog analytics for product improvements.
  - Default: `enabled`
  - Set to `disabled` to opt-out of analytics

- **`ARCHESTRA_ANALYTICS_POSTHOG_KEY`** - PostHog project key used when analytics is enabled.
  - Default: Archestra's hosted PostHog project key
  - Set this with `ARCHESTRA_ANALYTICS_POSTHOG_HOST` to send analytics to your own PostHog instance

- **`ARCHESTRA_ANALYTICS_POSTHOG_HOST`** - PostHog API host used when analytics is enabled.
  - Default: `https://eu.i.posthog.com`
  - Example: `https://posthog.example.com`

- **`ARCHESTRA_LOGGING_LEVEL`** - Log level for Archestra
  - Default: `info`
  - Supported values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`

- **`ARCHESTRA_LOGGING_FORMAT`** - Console log format written to stdout. The OTLP log exporter is unaffected and always receives structured records.
  - Default: `json`
  - Supported values: `json` (machine-readable, single-line JSON), `pretty` (human-readable, colorized)
  - The docker quickstart sets this to `pretty` by default; export `ARCHESTRA_LOGGING_FORMAT=json` to override.

### Authentication & Security

- **`ARCHESTRA_AUTH_SECRET`** - Secret key used for signing authentication tokens, encrypting secrets stored in the database, and encrypting JWKS private keys.
  - Auto-generated once on first run. Set manually if you need to control the secret value. Must be at least 32 characters long.
  - Example: `something-really-really-secret-12345`
  - **Warning:** Do not change this value after deployment. Rotating this secret will invalidate all user sessions (forcing re-login), make existing encrypted secrets unreadable, break JWT signing (JWKS private keys are encrypted with this secret), and break two-factor authentication for enrolled users.

- **`ARCHESTRA_AUTH_ADMIN_EMAIL`** - Email address for the default Archestra Admin user, created on startup.
  - Default: `admin@example.com`

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

- **`ARCHESTRA_AUTH_DCR_ENABLED`** - Controls OAuth Dynamic Client Registration (DCR, RFC 7591) and CIMD auto-registration.
  - Default: `true`
  - Set to `false` to allow only pre-registered OAuth clients to run OAuth flows. Runtime self-registration (`POST /api/auth/oauth2/register`) returns `403`, CIMD auto-registration is skipped, and the well-known metadata stops advertising the registration endpoint
  - Pair with manually registered [MCP OAuth clients](/docs/mcp-authentication) (both `client_credentials` and `authorization_code`) when you want to restrict gateway access to a known set of applications

- **`ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS`** - Extra trusted origins for CORS and authentication, in addition to `ARCHESTRA_FRONTEND_URL`. Setting this variable (even without `ARCHESTRA_FRONTEND_URL`) enables origin validation.
  - Default: None (origin validation is off when neither this nor `ARCHESTRA_FRONTEND_URL` is set)
  - Format: Comma-separated list of origins (e.g., `http://idp.example.com:8080,https://auth.example.com`)
  - Use this to trust external identity providers (IdPs) for SSO, or to allow access from multiple URLs (e.g., both a LAN IP and a domain name)
  - Example for LAN access alongside localhost: `http://192.168.1.5:3000,http://192.168.1.5:9000`

- **`ARCHESTRA_SECRETS_MANAGER`** - Secrets storage backend for managing sensitive data (API keys, tokens, etc.)
  - Default: `DB` (database storage)
  - Options: `DB`, `VAULT`, or `READONLY_VAULT`
  - Note: When set to `VAULT` or `READONLY_VAULT`, requires `ARCHESTRA_HASHICORP_VAULT_ADDR` and the credentials for the selected auth method. See [Secrets Management](/docs/platform-secrets-management) for the full configuration reference (KV version, secret path prefix, auth methods).

- **`ARCHESTRA_HASHICORP_VAULT_ADDR`** - HashiCorp Vault server address
  - Required when: `ARCHESTRA_SECRETS_MANAGER=VAULT` or `READONLY_VAULT`
  - Example: `http://localhost:8200`
  - Note: System falls back to database storage if Vault is configured but credentials are missing

- **`ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD`** - Authentication method used to connect to Vault.
  - Default: `TOKEN`
  - Options: `TOKEN`, `K8S`, `AWS`
  - See [Vault Authentication](/docs/platform-secrets-management#vault-authentication) for the per-method env vars (`ARCHESTRA_HASHICORP_VAULT_TOKEN`, `..._K8S_ROLE`, `..._AWS_ROLE`, etc.).

- **`ARCHESTRA_HASHICORP_VAULT_KV_VERSION`** - Version of Vault's KV secrets engine.
  - Default: `2`
  - Options: `1` or `2`
  - Applies to both `VAULT` and `READONLY_VAULT` modes. Changes the default secret path prefix and the API paths used for read/write/list/delete.

- **`ARCHESTRA_HASHICORP_VAULT_SECRET_PATH`** - Path prefix for Archestra-managed secrets in Vault.
  - Default: `secret/data/archestra` (KV v2) or `secret/archestra` (KV v1)
  - Use it to store secrets under a custom path.
  - KV v2 example: `kv/data/platform/archestra` (resolves to `kv/data/platform/archestra/{secretName}`)
  - KV v1 example: `kv/platform/archestra` (resolves to `kv/platform/archestra/{secretName}`)

- **`ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH`** - Override path prefix for KV v2 metadata operations (list, delete).
  - Default: derived from `ARCHESTRA_HASHICORP_VAULT_SECRET_PATH` by replacing `/data/` with `/metadata/`.
  - Only needed when your prefix doesn't follow the `/data/` ↔ `/metadata/` convention.

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

- **`ARCHESTRA_ANTHROPIC_AZURE_FOUNDRY_ENTRA_ID_ENABLED`** - Enable Microsoft Entra ID authentication for Anthropic models deployed in Microsoft Foundry.
  - Default: `false`
  - Set `ARCHESTRA_ANTHROPIC_BASE_URL=https://<resource-name>.services.ai.azure.com/anthropic`
  - Uses Azure Identity `DefaultAzureCredential` with token scope `https://ai.azure.com/.default`
  - Claude deployments must already exist in the Azure resource. Microsoft lists additional Claude prerequisites: paid eligible subscription, supported region, Azure Marketplace access for partner models, permission to subscribe to model offerings, and Contributor or Owner role on the resource group. Azure also requires Anthropic deployment metadata: `industry`, `organizationName`, and `countryCode`.

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

- **`ARCHESTRA_GITHUB_COPILOT_BASE_URL`** - Override the GitHub Copilot API base URL.
  - Default: `https://api.githubcopilot.com`
  - For GitHub Enterprise, use `https://copilot-api.<ghe-domain>`

- **`ARCHESTRA_GITHUB_COPILOT_TOKEN_EXCHANGE_URL`** - Endpoint that exchanges a user's GitHub OAuth token for a short-lived Copilot API bearer.
  - Default: `https://api.github.com/copilot_internal/v2/token`
  - Copilot has no static API keys: provider keys store the user's long-lived GitHub OAuth token, and the proxy performs this exchange (with caching) on every request

- **`ARCHESTRA_GITHUB_COPILOT_DEVICE_AUTH_BASE_URL`** - GitHub host serving the OAuth device-flow endpoints (`/login/device/code`, `/login/oauth/access_token`) used by the "Sign in with GitHub" flow and the connection-page setup script.
  - Default: `https://github.com`

- **`ARCHESTRA_GITHUB_COPILOT_CLIENT_ID`** - GitHub App client id used for the Copilot device flow.
  - Default: `Iv1.b507a08c87ecfe98` (the community-standard VS Code client id accepted by the Copilot token exchange)
  - Override this if your organization registers its own GitHub App with Copilot API access

- **`ARCHESTRA_AZURE_OPENAI_BASE_URL`** - Azure AI Foundry deployment endpoint URL.
  - Deployment URL format: `https://<resource-name>.openai.azure.com/openai/deployments/<deployment-name>`
  - Foundry v1 format: `https://<resource-name>.services.ai.azure.com/openai/v1`
  - Required to enable the Azure AI Foundry provider.
  - Use Foundry v1 for Azure-sold OpenAI-compatible models such as Grok.

- **`ARCHESTRA_AZURE_OPENAI_API_VERSION`** - Azure OpenAI REST API version.
  - Default: `2024-02-01`

- **`ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION`** - Azure Responses API version.
  - Default: `2025-04-01-preview`
  - Used only for Azure `/responses` requests. Keep `ARCHESTRA_AZURE_OPENAI_API_VERSION` for Azure Chat Completions and deployment discovery.

- **`ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED`** - Enable Microsoft Entra ID authentication for Azure OpenAI.
  - Default: `false`
  - Set to `true` to use Azure Identity `DefaultAzureCredential` instead of `ARCHESTRA_CHAT_AZURE_OPENAI_API_KEY`
  - Requires `ARCHESTRA_AZURE_OPENAI_BASE_URL`
  - Deployment URLs use token scope `https://cognitiveservices.azure.com/.default`; Foundry v1 URLs use `https://ai.azure.com/.default`

- **`ARCHESTRA_LLM_PROXY_MAX_VIRTUAL_KEYS`** - Maximum number of virtual API keys per LLM API key.
  - Default: `10`
  - See: [LLM Proxy Authentication](/docs/platform-llm-proxy-authentication)

- **`ARCHESTRA_LLM_PROXY_VIRTUAL_KEYS_DEFAULT_EXPIRATION_SECONDS`** - Default expiration time for newly created virtual API keys, in seconds.
  - Default: `2592000` (30 days)
  - Set to `0` to create virtual keys that never expire by default
  - Users can override this per-key when creating virtual keys via the UI

- **`ARCHESTRA_LLM_PROXY_UPSTREAM_TIMEOUT_MS`** - Headers/body timeout (milliseconds) for LLM-call fetches, applied as a custom undici dispatcher on both the chat→proxy and proxy→upstream hops.
  - Default: unset, i.e. undici's defaults (5 minutes for both headers and body timeout)
  - Opt-in: set a larger value (e.g. `600000` for 10 minutes) when an upstream's time-to-first-token can exceed 5 minutes — typically a slow CPU-only Ollama or vLLM model — which otherwise fails with `Headers Timeout Error`
  - Keep it finite so genuinely-dead upstreams still surface as errors

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
  - Supported `<PROVIDER>` values: `ANTHROPIC`, `OPENAI`, `OPENROUTER`, `GEMINI`, `CEREBRAS`, `COHERE`, `GROQ`, `XAI`, `MISTRAL`, `PERPLEXITY`, `VLLM`, `OLLAMA`, `ZHIPUAI`, `DEEPSEEK`, `GITHUB_COPILOT`, `BEDROCK`, `MINIMAX`, `AZURE_OPENAI`
  - These serve as fallback API keys when no organization default or profile-specific key is configured
  - Note: `ARCHESTRA_CHAT_VLLM_API_KEY` and `ARCHESTRA_CHAT_OLLAMA_API_KEY` are optional as most vLLM/Ollama deployments don't require authentication
  - Note: `ARCHESTRA_CHAT_GITHUB_COPILOT_API_KEY` holds a GitHub OAuth token (`gho_...`) of an account with a Copilot subscription, not a static API key
  - See [Chat](/docs/platform-chat) for full details on API key configuration and resolution order

- **`ARCHESTRA_CHAT_DEFAULT_PROVIDER`** - Default LLM provider for Chat and A2A features.
  - Default: `anthropic`
  - Options: `anthropic`, `openai`, `gemini`
  - Used when no profile-specific provider is configured

Active chat run wake-ups use Postgres `LISTEN/NOTIFY` by default. This gives fast reconnect replay and Stop handling without waiting for the fallback poll interval. Poll intervals still exist in this mode as a safety net, so missed notifications or broken listener connections do not block progress forever.

Enable polling compatibility only when your database endpoint cannot keep session-stable listener connections, such as PgBouncer transaction pooling or some managed/serverless database proxies. In that mode, active run replay and Stop handling rely on periodic database reads. Lower intervals react faster but create more reads; higher intervals reduce database load but make replay and Stop slower.

- **`ARCHESTRA_CHAT_ACTIVE_RUN_REPLAY_POLL_INTERVAL_MS`** - Fallback/poll interval for replaying active chat runs after reconnect.
  - Default: `500`
  - Load model: roughly one replay-check read per reconnecting client per interval while waiting for new events

- **`ARCHESTRA_CHAT_ACTIVE_RUN_STOP_POLL_INTERVAL_MS`** - Interval for checking whether a running chat stream has been explicitly stopped.
  - With Postgres `LISTEN/NOTIFY`, Stop requests normally wake streams immediately; this interval is only a safety fallback if notification wake-up is missed
  - With polling compatibility enabled, this is the primary polling interval
  - Default: `30000` with Postgres `LISTEN/NOTIFY`, `500` when polling compatibility is enabled
  - Load model: roughly one stop-check read per running chat stream per interval

- **`ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED`** - Uses polling only instead of the default Postgres `LISTEN/NOTIFY` wake-ups for active chat run replay and stop detection.
  - Default: `false`
  - Keep disabled when direct Postgres or session pooling is available

- **`ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL`** - Optional Postgres connection string for active chat run `LISTEN/NOTIFY`.
  - Default: Uses `ARCHESTRA_DATABASE_URL`
  - Set this when regular database traffic goes through PgBouncer transaction pooling but notifications can use a direct or session-pooled connection

- **`ARCHESTRA_CHAT_SECRET_SCAN_ENABLED`** - Enables client-side pre-send scanning of chat messages for secrets and high-entropy tokens.
  - Default: `true`
  - When enabled, the chat composer intercepts sends and shows a confirmation dialog when the message appears to contain credentials (API keys, tokens, passwords, JWTs, PEM keys, or high-entropy strings). Set to `false` to disable.
  - This is a client-side convenience nudge, not a data-loss-prevention control: it runs in the browser and can be bypassed with "Send anyway".
  - Detection runs entirely in the browser — no message content is sent to the backend for scanning. The flag is read from the backend at runtime via `/api/config`, so toggling it does not require a frontend rebuild.
  - Values: `true`, `false`

### MCP Apps Sandbox

MCP Apps run inside sandboxed iframes with cross-origin isolation, CSP enforcement, and a double-iframe architecture. The sandbox proxy is served from the main backend under `/_sandbox/` — no separate port or service is needed.

#### How It Works by Environment

| Environment                              | Isolation method                                                    | Config needed                                     | MCP App capabilities                                 |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| **Local dev / Quickstart** (`localhost`) | `localhost` ↔ `127.0.0.1` origin swap (same port, different origin) | None                                              | Full (localStorage, CORS, etc.)                      |
| **Production with sandbox domain**       | Dedicated subdomain per MCP server                                  | `ARCHESTRA_MCP_SANDBOX_DOMAIN` + wildcard DNS/TLS | Full                                                 |
| **Production without sandbox domain**    | Opaque origin (iframe `sandbox` attribute)                          | None                                              | Limited (no localStorage, no origin-restricted CORS) |

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

- **`ARCHESTRA_ORCHESTRATOR_ENVIRONMENT_NAMESPACES`** - Comma-separated namespaces the platform ServiceAccount is granted RBAC in (mirrors the Helm chart's `archestra.orchestrator.kubernetes.rbac.environmentNamespaces`, which is injected automatically). Surfaced to the UI so the environment editor offers a namespace dropdown instead of free text; leave empty to keep free-text entry.
  - Default: empty
  - Example: `staging,production`

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

- **`ARCHESTRA_OTEL_TRACES_SAMPLE_RATE`** - Sampling rate for OTEL traces when Sentry is not enabled. Value between 0 and 1.
  - Default: `1.0` (100% of traces sampled)
  - Uses `ParentBasedSampler` with `TraceIdRatioBasedSampler` — child spans inherit the parent's sampling decision
  - Ignored when Sentry is enabled (sampling is managed by Sentry's `ARCHESTRA_SENTRY_TRACES_SAMPLE_RATE`)

- **`ARCHESTRA_OTEL_VERBOSE_TRACING`** - Enable verbose infrastructure spans (HTTP routes, outgoing HTTP calls, Node.js fetch, etc).
  - Default: `false` (disabled)
  - When disabled, traces only contain GenAI-specific spans (LLM calls, MCP tool calls) for a clean, focused view
  - Set to `true` to include infrastructure spans for debugging request flows

- **`ARCHESTRA_METRICS_PORT`** - TCP port for the metrics server.
  - Default: `9050`
  - Must be an integer between `1` and `65535`; invalid values fall back to the default with a warning

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

#### Public URL (ngrok)

Inbound chatops webhooks (MS Teams, Slack webhook mode) require this instance to be reachable from the Internet. When `ARCHESTRA_NGROK_AUTH_TOKEN` is set, the backend opens an [ngrok](https://ngrok.com) tunnel in-process on startup — no separate ngrok process or CLI binary is needed.

- **`ARCHESTRA_NGROK_AUTH_TOKEN`** - ngrok auth token. When set, the backend tunnels the API port so webhooks are reachable.
  - Get one at [dashboard.ngrok.com](https://dashboard.ngrok.com/get-started/your-authtoken)
- **`ARCHESTRA_NGROK_DOMAIN`** - Reserved ngrok domain for a stable public URL.
  - Optional: without it ngrok assigns an ephemeral domain that rotates on each restart
  - Recommended for MS Teams, whose messaging endpoint is registered statically in Azure

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

These environment variables configure the [Knowledge Base](/docs/platform-knowledge-bases). Knowledge Bases use a built-in RAG stack powered by pgvector for document chunking, embedding, and hybrid search.

- **Embedding and reranker API keys** are configured via LLM Provider Keys in **Settings > Knowledge**, not via environment variables. See [Embedding Configuration](/docs/platform-knowledge-bases#embedding-configuration) and [Reranking Configuration](/docs/platform-knowledge-bases#reranking-configuration) for how to pick the key and model.

- **`ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_SYNC_MAX_DURATION_SECONDS`** - Maximum duration for a single connector sync run before it stops and triggers a continuation.
  - Default: `3300` (55 minutes)
  - Only applies to K8s CronJob runs. When a sync exceeds 90% of this budget, it stops and creates a continuation Job to resume from the last checkpoint.
  - Set to `0` to disable time-bounded runs.

- **`ARCHESTRA_KNOWLEDGE_BASE_HYBRID_SEARCH_ENABLED`** - Enable or disable hybrid search (combines vector similarity with full-text search using Reciprocal Rank Fusion).
  - Default: `true`
  - Set to `false` to use vector similarity search only.

### Audit Log Configuration

The audit log records administrative actions (mutations via `/api/*` and auth events) across your organization. Automatic retention is **disabled by default** - audit rows are kept indefinitely unless an org admin opts in by setting a positive retention window.

- **`ARCHESTRA_AUDIT_LOG_RETENTION_DAYS`** - Number of days to retain audit log records before they are automatically deleted by the daily retention sweep.
  - Default: `0` (disabled — audit rows are never auto-deleted).
  - Set to a positive integer (e.g. `90`, `180`) to opt in to automatic purging after that many days.
  - Must be a non-negative integer; invalid values fall back to the default (disabled).
  - When enabled, the sweep runs once every 24 hours as a background task.

### Maintenance Mode

- **`ARCHESTRA_MAINTENANCE_MODE_MESSAGE`** - Enables maintenance mode and displays a custom message to all users blocking access to the platform.
  - Default: Not set (maintenance mode disabled)
  - When set, all users are shown a full-screen maintenance overlay with the message instead of the normal application interface.

### Enterprise Licensing

To learn more about enterprise licensing, see the [pricing model](/docs/platform-pricing-model).

