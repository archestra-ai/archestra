---
title: Deployment
category: Archestra Platform
order: 3
lastUpdated: 2026-08-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

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

To use an external PostgreSQL database, pass the `ARCHESTRA_DATABASE_URL` environment variable. `DATABASE_URL` is still accepted as a fallback.

```bash
docker pull archestra/platform:latest;
docker run -p 127.0.0.1:9000:9000 -p 127.0.0.1:3000:3000 \
  -e ARCHESTRA_DATABASE_URL=postgresql://user:password@host:5432/database \
  archestra/platform
```

⚠️ **Important**: If you don't specify `ARCHESTRA_DATABASE_URL` or `DATABASE_URL`, PostgreSQL will run inside the container for you. This approach is meant for **development and tinkering purposes only** and is **not intended for production**, as the data is not persisted when the container stops.

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

**Auth secret configuration**: the auth secrets are optional. If you do not configure them, the Helm chart creates a `<release>-auth` Secret and auto-generates 64-character `session-secret` and `secrets-encryption-secret` values on first install.

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
--set archestra.env.ARCHESTRA_AUTH_SESSION_SECRET=<generated-secret> \
--set archestra.env.ARCHESTRA_SECRETS_ENCRYPTION_SECRET=<generated-secret>
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
- `archestra.orchestrator.mcpServerResources.requests.cpu` - CPU request for generated MCP server containers (default: `50m`)
- `archestra.orchestrator.mcpServerResources.requests.memory` - Memory request for generated MCP server containers (default: `128Mi`)
- `archestra.orchestrator.mcpServerResources.requests.ephemeralStorage` - Ephemeral-storage request for generated MCP server containers (default: `256Mi`)
- `archestra.orchestrator.mcpServerResources.limits.memory` - Memory limit for generated MCP server containers (default: `512Mi`)
- `archestra.orchestrator.mcpServerResources.limits.ephemeralStorage` - Ephemeral-storage limit for generated MCP server containers (default: `1Gi`)
- `archestra.orchestrator.failedPodReapIntervalSeconds` - How often Failed or Evicted MCP server pods are garbage-collected (default: `600`, `0` disables)

**Kubernetes Settings**:

- `archestra.orchestrator.kubernetes.namespace` - Kubernetes namespace where MCP server pods will be created (defaults to Helm release namespace). Create a custom namespace before installing; the chart grants the platform ServiceAccount access to it.
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
- `archestra.webContainerReservedMemoryMib` - Memory in the web container reserved for the Next.js server instead of the backend's V8 heap (default: 384). The container runs both processes under one limit, so the backend's heap ceiling is a percentage of the limit minus this reservation. Raise it if you run an unusually heavy frontend workload.
- `archestra.horizontalPodAutoscaler` - Optional HPA for the main `archestra-platform` Deployment. When enabled, the chart defaults to `minReplicas: 2`, `maxReplicas: 10`, a memory utilization target of 70%, immediate scale-up, and a 5-minute scale-down stabilization window.
- `archestra.worker.replicaCount` - Manual replica count for the separate worker Deployment
- `archestra.worker.resources` - Resource requests/limits for worker pods (default: 2 vCPU request, 1Gi memory request, 2Gi memory limit)
- `archestra.worker.deploymentStrategy` - Rolling update strategy for worker pods (default: `maxUnavailable: 25%`, `maxSurge: 25%`)
- `archestra.migrationJob.enabled` - Run database migrations in a pre-upgrade Job before rolling web and worker pods (default: true)
- `archestra.migrationJob.resources` - CPU and memory requests/limits for the migration container (default: 500m CPU request, 512Mi memory request, 2Gi memory limit)
- `archestra.migrationJob.lockTimeout` - PostgreSQL `lock_timeout` for the migration session (default: `5s`). Migrations fail fast instead of blocking live traffic behind a table lock. Set to `null` to disable.
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

##### Keep-Alive Timeouts

Response timeouts are only half of the setting. A load balancer also keeps idle connections to Archestra open and reuses them for later requests. If Archestra closes one of those connections first, the load balancer can send a request onto it at the moment it goes away. That request fails in transit. The client sees an occasional dropped request or a 502 on a call that would otherwise have worked.

Archestra holds an idle connection for 620 seconds, which clears the longest window in common use — Google Cloud holds backend connections for a fixed 600 seconds. Set `ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS` higher if your load balancer keeps connections longer than that:

```yaml
archestra:
  env:
    ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS: "900000" # 900s
```

The value applies to both the API and the frontend server.

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

For external PostgreSQL, store the complete connection URL in a Kubernetes
Secret. This keeps credentials out of shell history and Helm release values.
The example below expects `archestra-database` to contain a `url` key:

```yaml
postgresql:
  enabled: false

archestra:
  envWithValueFrom:
    - name: ARCHESTRA_DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: archestra-database
          key: url
  migrationJob:
    envWithValueFrom:
      - name: ARCHESTRA_DATABASE_URL
        valueFrom:
          secretKeyRef:
            name: archestra-database
            key: url
```

If you don't specify `postgresql.external_database_url`, the chart will deploy a managed PostgreSQL instance using the Bitnami PostgreSQL chart. For PostgreSQL-specific configuration options, see the [Bitnami PostgreSQL Helm chart documentation](https://artifacthub.io/packages/helm/bitnami/postgresql?modal=values-schema).

The included PostgreSQL image is pinned by digest, so the database version only changes when the chart updates `postgresql.image.digest`. The included instance runs a single replica — it restarts during some upgrades, so use an external database where downtime matters.

During Helm upgrades, the chart runs `node ./scripts/migrate-with-lock.mjs` in a pre-upgrade Job before rolling the web and worker Deployments. The Job runs with a PostgreSQL `lock_timeout` (`archestra.migrationJob.lockTimeout`, default `5s`) — a migration that cannot get a table lock fails and retries instead of blocking live traffic. Disable `archestra.migrationJob.enabled` only if your deployment pipeline applies migrations out of band. This also disables migrations during web pod startup.

Alternatively, set `postgresql.external_database_url`; the chart stores it in a Kubernetes Secret and passes it to the migration Job automatically.

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

Archestra protects every MCP server pod from Server-Side Request Forgery (SSRF) automatically — there is no Helm toggle to turn on. The backend applies an egress policy to each pod, so a server cannot reach cloud metadata endpoints or private cluster ranges unless its environment network policy explicitly allows it.

Each pod gets one policy, chosen by its environment's egress mode:

- **Public internet** (`unrestricted`, the default) — DNS and public egress are allowed. Explicit CIDRs can open selected private ranges; other private, link-local, metadata, and reserved ranges remain blocked.
- **Allowlist** (`restricted`) — only the CIDRs and domains the environment allow-lists, plus DNS.
- **Block all** (`off`) — all egress is denied.

A namespace-wide default-deny baseline also selects every MCP pod, so a pod that is still starting up is denied by default rather than left open.

Public internet uses a maintained floor for private, metadata, and reserved destinations. See [The Public Internet Floor](/docs/platform-environments#the-public-internet-floor) for the exact ranges and CIDR exception behavior.

**Prerequisite**: your cluster must use a CNI that enforces network policies. Calico, Cilium, and GKE Dataplane V2 enforce standard `NetworkPolicy` objects; on EKS Auto Mode, where `ApplicationNetworkPolicy` is the enforcement mechanism, the policy is emitted as an `ApplicationNetworkPolicy` instead. Where no enforcing dataplane is present, the policies are created but not enforced.

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

For production deployments, we strongly recommend using a cloud-hosted PostgreSQL database instead of the included PostgreSQL instance. Cloud-managed databases provide:

- **High availability** with automatic failover
- **Automated backups** and point-in-time recovery
- **Scaling** without downtime
- **Security** with encryption at rest and in transit
- **Monitoring** and alerting out of the box

To use an external database, specify the connection string via the `ARCHESTRA_DATABASE_URL` environment variable. When using an external database, the included PostgreSQL instance is automatically disabled. See the [Environment Variables](#environment-variables) section for details.

##### pgvector Extension (Knowledge Base Feature)

The [Knowledge Base](/docs/platform-knowledge) enterprise feature requires the [pgvector](https://github.com/pgvector/pgvector) PostgreSQL extension for vector similarity search. The database user specified in `ARCHESTRA_DATABASE_URL` must have permission to run `CREATE EXTENSION vector`, which typically requires **superuser** privileges.

**Cloud-managed databases:**

- **AWS RDS** — pgvector is available but is [not a trusted extension](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.Extensions.html#PostgreSQL.Concepts.General.Extensions.Trusted), so it must be installed by a user with the `rds_superuser` role. Connect as the RDS master user and run `CREATE EXTENSION vector`.
- **Google Cloud SQL** — pgvector is [supported natively](https://cloud.google.com/sql/docs/postgres/extensions#pgvector). Enable it via the Cloud SQL console or `CREATE EXTENSION vector`.
- **Azure Database for PostgreSQL** — pgvector is [available as an extension](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-extensions). Allow-list it in server parameters, then run `CREATE EXTENSION vector`.

**Self-managed PostgreSQL:** Install the pgvector package for your distribution (e.g., `apt install postgresql-17-pgvector`) and ensure the database user has `CREATE` privilege on the database, or grant `SUPERUSER` to allow extension creation.

If pgvector is not installed or the database user lacks permissions, the Knowledge Base migration will fail. This does not affect other Archestra features.

#### SSRF Protection

MCP server pods are protected from SSRF automatically: each pod's egress is confined to DNS and the public internet, with private and cloud-metadata ranges blocked. This matters most when MCP servers run untrusted code. To tighten a server to a specific allow-list — or deny its egress entirely — set its environment's network policy. See [SSRF Protection for MCP Server Pods](#ssrf-protection-for-mcp-server-pods).

## Infrastructure as Code

Manage Archestra resources from Terraform or Crossplane. Both use the same API key — mint one in the API Keys section in Personal Settings (click your name in the sidebar) (see [API Reference](/docs/platform-api-reference#authentication)).

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

The same resources are also available as a Crossplane v1/v2 provider for teams that prefer GitOps-style reconciliation on Kubernetes. The xpkg is [upjet](https://github.com/crossplane/upjet)-generated from the Terraform provider's schema and published from the same release tag, so the two stay version-locked. Crossplane v1 or v2 must already be installed in the target cluster.

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

Full resource reference: [Crossplane provider README](https://github.com/archestra-ai/terraform-provider-archestra/blob/main/crossplane/README.md). Resource coverage is partial — current state and the gap vs. the Terraform provider are tracked on the [coverage badge](https://github.com/archestra-ai/terraform-provider-archestra#archestra-provider).

## Environment Variables

The following environment variables can be used to configure Archestra Platform.

### Database

- **`ARCHESTRA_DATABASE_URL`** - PostgreSQL connection string for the database.
  - Format: `postgresql://user:password@host:5432/database`
  - Default: Internal PostgreSQL (Docker) or managed instance (Helm)
  - Required for production deployments with external database

- **`ARCHESTRA_DATABASE_RUN_MIGRATIONS_ON_STARTUP`** - Runs database migrations before backend startup.
  - Default: `true`
  - Set to `false` only when your deployment pipeline applies migrations before rollout.

- **`ARCHESTRA_DATABASE_POOL_MAX`** - Maximum number of PostgreSQL connections per backend pod.
  - Default: `50`
  - Range: `1`–`500`
  - Tune this when you have many concurrent users or long-running chat streams. The backend opens at most `ARCHESTRA_DATABASE_POOL_MAX` connections per pod, so coordinate with PostgreSQL `max_connections` to ensure `pods × ARCHESTRA_DATABASE_POOL_MAX < max_connections` with headroom for admin sessions. On managed Postgres (e.g. AWS RDS, Cloud SQL) the server limit is typically several thousand and rarely the binding constraint.

- **`ARCHESTRA_DATABASE_STATEMENT_TIMEOUT_MILLIS`** - Per-connection PostgreSQL `statement_timeout` (in milliseconds) applied to every pooled connection.
  - Default: `30000` (30s)
  - Set to `0` to disable the timeout entirely.
  - Defense-in-depth against pathological queries: any statement running longer than this is cancelled by PostgreSQL so a single slow query can't hold a connection open indefinitely. Raise it if you have legitimate long-running analytical queries.

### Application & API Configuration

- **`ARCHESTRA_API_BASE_URL`** - Archestra API Base URL(s) for connecting to Archestra's LLM Proxy, MCP Gateway and A2A Gateway.

  This URL is displayed in the UI connection instructions to help users configure their agents. It doesn\'t affect internal routing (Archestra frontend communicates with backend via `http://127.0.0.1:9000`).
  - Default: Falls back to `http://127.0.0.1:9000`
  - Supports multiple comma-separated URLs for different connection options (e.g., internal K8s URL and external ingress)
  - Single URL example: `https://api.archestra.com`
  - Multiple URLs example: `http://archestra.default.svc:9000,https://api.archestra.example.com`
  - Use case: Set this when your external access URL differs from the internal service URL (common in Kubernetes with ingress/load balancers)

- **`ARCHESTRA_PUBLIC_ENDPOINTS_PORT`** - Dedicated TCP port for the publicly-exposable endpoints — currently the MS Teams incoming webhook (`/api/webhooks/chatops/ms-teams`).
  - Default: Not set (these endpoints are served on the main API port only)
  - When set, a second listener serves these endpoints on this port. The main API port keeps serving them too — the dedicated port is an alias.
  - Use case: expose only these endpoints to the Internet in a firewall or load balancer, without exposing the whole API
  - Must be an integer between `1` and `65535`; invalid values disable the listener with a warning
  - Helm: set `archestra.publicEndpointsPort` to inject this variable and expose the port on the Service

- **`ARCHESTRA_TRUST_PROXY`** - Controls whether Archestra trusts the `X-Forwarded-*` headers a proxy sets. Set it when Archestra runs behind a TLS-terminating reverse proxy or load balancer (e.g. AWS ALB, nginx, Cloudflare).
  - Default: `false` (no proxy trust)
  - Values: `true`, `false`, or a comma-separated list of trusted proxy IPs/CIDRs (e.g. `10.0.0.0/8,172.16.0.0/12`)
  - Example: `ARCHESTRA_TRUST_PROXY=35.191.0.0/16,130.211.0.0/22`
  - Generated OAuth metadata and auth URLs use the external `https://` scheme instead of the internal `http://` scheme the backend sees.
  - Each request resolves to the calling client's IP rather than the proxy's. Per-IP rate limits and audit `sourceIp` values follow that IP. Behind a load balancer they stay per-client instead of collapsing onto one shared address.
  - Prefer the IP/CIDR list over `true`. With `true`, Archestra trusts a client-supplied `X-Forwarded-For` header, so a caller can choose the IP it is rate-limited and audited under. List your proxy's own ranges instead.
  - This setting does not affect the OAuth public origin. A forwarded host is always checked against `ARCHESTRA_API_BASE_URL` and `ARCHESTRA_FRONTEND_URL`, so name your public host in one of them.

- **`ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS`** - How long each HTTP server holds an idle keep-alive connection open before closing it. Applies to the API and the frontend server.
  - Default: `620000` (620 seconds)
  - Value: digits only, a positive whole number of milliseconds. Anything else — a decimal, a unit suffix, a digit separator, scientific or hex notation — falls back to the default and logs a warning, rather than being truncated to the digits it starts with. The container entrypoint applies the same rule before either server starts, so both always agree.
  - Keep it above the keep-alive timeout of every proxy and load balancer in front of Archestra. A proxy that outlives the server can reuse a connection while the server closes it, which drops the request. See [Keep-Alive Timeouts](#keep-alive-timeouts).
  - Lower it only when nothing pools connections to Archestra.

- **`ARCHESTRA_API_BODY_LIMIT`** - Maximum request body size for LLM proxy and chat routes.
  - Default: `70MB` (73400320 bytes)
  - Format: Numeric bytes (e.g., `73400320`) or human-readable (e.g., `70MB`, `100KB`, `1GB`)
  - Note: Increase this if you have conversations with very large context windows (100k+ tokens) or large file attachments in chat. The default carries a max-size chat attachment as base64 plus room for history; raising `ARCHESTRA_CHAT_ATTACHMENT_STORAGE_BYTES_LIMIT` requires raising this too.
  - All attachments of one chat message travel in a single request, so this also bounds their combined size. The chat composer blocks a message whose attachments exceed it and asks the user to send them separately.

- **`ARCHESTRA_FRONTEND_URL`** - Setting this variable enables origin validation for CORS and authentication. When set, only requests from this origin (and any in `ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS`) are allowed. When not set, all origins are accepted.
  - Example: `https://frontend.example.com`
  - Highly recommended for production.
  - If users access the platform via a LAN IP (e.g., `http://192.168.1.5:3000`), set this to that URL

- **`ARCHESTRA_MCP_SANDBOX_DOMAIN`** - Wildcard domain for MCP App sandbox isolation. Gives each MCP server a unique subdomain origin, enabling localStorage, CORS, and OAuth for MCP Apps. Not needed for local development (automatic localhost swap provides isolation).
  - Example: `mcp.example.com`
  - Requires wildcard DNS (`*.mcp.example.com`) and wildcard TLS certificate pointing to the backend
  - See [MCP Apps Sandbox](#mcp-apps-sandbox) for setup instructions

- **`ARCHESTRA_BETA`** - Fallback for per-feature `ARCHESTRA_*_ENABLED` gates (see `betaFeatureEnabled`).
  - Default: `false`
  - Values: `true`, `false`

### Code Sandbox

Archestra creates one Dagger engine per organization, and one per environment, as a StatefulSet in the namespace that owns it. Each engine pod runs privileged, adds all Linux capabilities, runs as root, and binds a `ReadWriteOnce` PVC for its build cache. An engine schedules only on nodes whose pod-security policy admits those settings and where the PVC can bind. Size the pod with the `ARCHESTRA_DAGGER_RUNTIME_ENGINE_*` variables below.

To run your own engine instead of the ones Archestra creates, set `ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST` to a `tcp://` or `kube-pod://` address. See Dagger's [custom runner](https://docs.dagger.io/reference/configuration/custom-runner) and [deployment](https://docs.dagger.io/reference/#deployment) references for the runner host schemes and engine requirements.

If your nodes cannot host a privileged pod, either point `ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST` at an engine you run elsewhere, or turn the sandbox off with `ARCHESTRA_CODE_RUNTIME_ENABLED=false` in Docker or `archestra.codeRuntime.enabled=false` in Helm values.

Upgrading from a chart that ran the included engine leaves its cache volume behind. The old `dagger-runtime-engine` StatefulSet is gone, but Kubernetes keeps its `data-dagger-runtime-engine-0` PVC and the disk it holds. Delete it once after the upgrade: `kubectl delete pvc data-dagger-runtime-engine-0 -n <release-namespace>`.

- **`ARCHESTRA_CODE_RUNTIME_ENABLED`** - Enables the code runtime — the per-conversation [code sandbox](./platform-code-sandbox) where agents run shell commands and Python, execute skill scripts, and run agent hooks. Set `false` to turn the sandbox off; that wins even when a runner host is set. Set `true` with the orchestrator configured (`ARCHESTRA_ORCHESTRATOR_KUBECONFIG` or `ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER`) and Archestra creates one Dagger engine per organization. Kubernetes is required for that: the engines are Kubernetes workloads. When off, `run_command` and the other sandbox tools are unavailable and skills cannot execute. The quickstart Docker image and the Helm chart enable it by default; opt out with `ARCHESTRA_CODE_RUNTIME_ENABLED=false` in Docker or `archestra.codeRuntime.enabled=false` in Helm values.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST`** - Address of an existing Dagger engine, for example `tcp://dagger-engine:8080` or a `kube-pod://` URL. Set it to run your own engine: Archestra sends agents without an environment to that address and creates no default engine. An agent bound to an environment still runs on that environment's own engine, which Archestra creates and which needs Kubernetes. A `kube-pod://` host is reached by running a command inside its pod, so it needs Kubernetes as well; only a `tcp://` host runs without it. Setting this also enables the code runtime on its own. A value that is not a `tcp://` or `kube-pod://` URL is rejected and turns the code runtime off rather than falling back to an Archestra-managed engine, so a typo cannot silently provision engines you did not ask for. Leave it unset to let Archestra manage every engine.
  - Default: unset
  - Values: a `tcp://` or `kube-pod://` URL

- **`ARCHESTRA_DAGGER_RUNTIME_IMAGE`** - Base image for Dagger sandboxes. Leave unset to use the default `ghcr.io/astral-sh/uv:0.9.17-python3.12-bookworm-slim` image.
  - Default: unset
  - Use this to point at a custom Debian-based image or a pre-baked sandbox base.

- **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_CPU_REQUEST`**, **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_REQUEST`**, **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_LIMIT`**, **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_CACHE_STORAGE`** - Resources for an engine Archestra creates. Lower them for a small cluster. They apply to new engines only; delete an engine to resize it.
  - The memory limit covers the engine itself, not the code it sandboxes. Use `ARCHESTRA_DAGGER_RUNTIME_ENGINE_SANDBOX_MEMORY_MAX` for that. The memory request reserves node capacity for both.
  - Defaults: `2`, `6Gi`, `6Gi`, `50Gi`
  - Values: Kubernetes quantity strings

- **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_SANDBOX_MEMORY_MAX`** - Limits the memory an engine's sandboxes use at once. A run that goes past it is killed; the engine and other runs keep going. Raise it and the memory request together for heavy concurrent work, or lower `ARCHESTRA_DAGGER_RUNTIME_MAX_CONCURRENT`.
  - Default: `5Gi`. Keep it below `ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_REQUEST`.
  - Values: Kubernetes quantity strings

- **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_ADDITIONAL_DENIED_CIDRS`** - Extra IPv4 ranges an engine cannot reach. An engine with no [network policy](./platform-environments) already blocks private, link-local, and cloud-metadata ranges. Add your cluster's Service and Pod CIDRs when they fall outside those ranges, so sandboxed code cannot reach in-cluster services. An entry that is not a valid IPv4 CIDR is ignored, and the backend logs which ones.
  - Default: unset
  - Values: comma-separated CIDRs, for example `100.68.0.0/16,34.118.224.0/20`

- **`ARCHESTRA_CODE_RUNTIME_BASE_PREBUILT`** - Set `true` only when `ARCHESTRA_DAGGER_RUNTIME_IMAGE` points at a pre-baked sandbox base image that already contains the apt toolbelt, the `uv` virtualenv, and the default Python dependencies. The runtime then skips the per-sandbox apt/`uv` build steps and instead verifies a provenance marker on the image — failing loudly if the image isn't the baked base — so an engine with restricted egress no longer needs to reach `ghcr.io`, the Debian mirrors, or PyPI when it materializes a sandbox; only the registry hosting the base image. Leave `false` (the default) to build the base from the stock runtime image on first use.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_SKILLS_SANDBOX_CPU_LIMIT_SECONDS`** - CPU-time cap for a single sandbox command.
  - Default: `30`
- **`ARCHESTRA_SKILLS_SANDBOX_MEMORY_LIMIT_BYTES`** - Memory cap for the sandbox container.
  - Default: `1073741824` (1 GiB)
- **`ARCHESTRA_SKILLS_SANDBOX_WALL_CLOCK_SECONDS`** - Wall-clock cap for a single command; a caller-supplied timeout is clamped to this.
  - Default: `120`
- **`ARCHESTRA_SKILLS_SANDBOX_OUTPUT_BYTES_LIMIT`** - Maximum captured stdout/stderr per command; output beyond this is truncated.
  - Default: `262144` (256 KiB)
- **`ARCHESTRA_SKILLS_SANDBOX_ARTIFACT_BYTES_LIMIT`** - Maximum size of a file the sandbox can export to the conversation's Files panel, and of a chat attachment it can stage for the agent to read.
  - Default: `52428800` (50 MiB), matching `ARCHESTRA_CHAT_ATTACHMENT_STORAGE_BYTES_LIMIT` so every stored attachment can be staged.
  - Lowering it does not cap what chat can upload. An attachment over this limit skips sandbox staging and is still stored.
- **`ARCHESTRA_DAGGER_RUNTIME_MAX_CONCURRENT`** - Sandbox commands the shared Dagger session runs at once, deployment-wide. Raise it with the engine's CPU and memory.
  - Default: `10`
- **`ARCHESTRA_DAGGER_RUNTIME_MAX_QUEUE_LENGTH`** - Sandbox commands allowed to wait for a free slot. Past this, a command fails with a runtime-at-capacity error instead of queueing.
  - Default: `50`

### Agent Background Execution

Background execution runs delegated Agent tasks in dedicated Kubernetes pods. You can view logs, open a shell, and steer a run while it is active. It needs the Kubernetes runtime configured (see `ARCHESTRA_ORCHESTRATOR_*`); without it the capability stays unavailable.

- **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ENABLED`** - Enables Background execution. A run can carry the credentials of the person who started it, so this gate is independent of `ARCHESTRA_BETA` and never turns on by implication.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_BASE_IMAGE`** - Container image prefilled when Background execution is enabled on an Agent. The built-in image supplies the default Agent loop; custom images can replace it and set their own command.
  - Default: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-archestra:latest`

- **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ALLOW_PRIVILEGED`** - Allows Agent administrators to configure privileged background pods. Privileged containers have node-level access.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_PLATFORM_BASE_URL`** - Base URL a background pod uses to reach the LLM proxy and the MCP gateway. It has to be reachable from inside the cluster. With neither this nor `ARCHESTRA_INTERNAL_API_BASE_URL` set, starting a run fails rather than letting it bypass the proxy.
  - Default: `ARCHESTRA_INTERNAL_API_BASE_URL`

- **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_DEFAULT_TTL_HOURS`** - Lifetime cap for runs whose Agent sets none. Kubernetes enforces it on the workload as well.
  - Default: `72`

- **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_DEFAULT_IDLE_TIMEOUT_MINUTES`** - How long the built-in execution agent waits for another steer after finishing its current work before the run exits. An Agent can override this value. Custom images receive the timeout as `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_IDLE_TIMEOUT_SECONDS` and must implement the wait themselves.
  - Default: `180`

- **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_CPU_REQUEST`**, **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MEMORY_REQUEST`**, **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MEMORY_LIMIT`** - Pod resources for a run whose Agent sets none. There is no CPU limit by default: throttling an agent mid-turn reads as a hang rather than back-pressure.
  - Defaults: `500m`, `1Gi`, `4Gi`

- **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_EPHEMERAL_STORAGE_LIMIT`** - Maximum writable scratch space for one execution. Kubernetes enforces the limit on the run's `emptyDir` volume.
  - Default: `10Gi`

- **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_PLATFORM_POD_SELECTOR`** - Label selector matching the platform's own API pods, written as `key=value` pairs. Background pods get an egress policy allowing exactly that destination. Override it when your deployment labels the platform differently.
  - Default: `archestra.io/p4-shim-client=true`

- **`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_RECONCILE_INTERVAL_SECONDS`** - How often the reconciler syncs run state and applies the lifetime and idle stops.
  - Default: `30`

### Skills Marketplace

- **`ARCHESTRA_PLUGINS_ENABLED`** - Enables the Plugins catalog, an initial OpenAPPA import, and delivery through connection setup commands. Plugin files execute on connected developer machines, so this gate is off by default.
  - Default: unset (falls back to the `ARCHESTRA_BETA` master switch)
  - Values: `true`, `false`
  - An explicit `false` keeps the feature off even when `ARCHESTRA_BETA=true`.

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
  - Default: `enabled` in production builds (`NODE_ENV=production`, which includes the released Docker images); disabled in development/test environments
  - Set to `disabled` to opt-out of analytics, or `enabled` to force it on regardless of environment

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

- **`ARCHESTRA_AUTH_SESSION_SECRET`** - Session-signing secret (better-auth). Signs session cookies and the `session_data` cookie cache, and encrypts better-auth-internal material: JWKS private keys and two-factor secrets.
  - Auto-generated once by Helm in the auth Secret under the `session-secret` key. Set manually to control it; must be at least 32 characters.
  - **Rotating it** invalidates all sessions (forces re-login), regenerates JWKS (in-flight JWTs stop verifying), and breaks two-factor enrollment (enrolled users must re-enroll). No database migration is needed.

- **`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`** - Derives the AES key that encrypts secrets stored in the database (`secret` table). Independent of sessions/JWKS/2FA.
  - Auto-generated once by Helm in the auth Secret under the `secrets-encryption-secret` key. Set manually to control it; must be at least 32 characters.
  - Startup verifies this key against previously encrypted secrets and aborts on a mismatch (see `ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY`).
  - **Rotating it** requires re-encrypting existing rows: set `ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS` to the old value and restart — the app re-encrypts stored secrets on startup, decrypting each with the previous key and re-encrypting with the new one (idempotent, and a no-op when the key is unchanged). You can also run it explicitly with `pnpm --filter backend db:reencrypt-secrets`. Vault-managed secrets are unaffected.

- **`ARCHESTRA_CONTENT_ENCRYPTION_SECRET`** - Enables enterprise content encryption at rest: LLM interaction payloads, chat message content, and MCP tool call arguments/results are encrypted in the database with a key derived from this secret, separate from the stored-secrets key.
  - Default: not set (disabled). Operator-supplied only — never auto-generated.
  - Requires an enterprise license; startup fails when set without one.
  - Existing rows are encrypted by a background sweep after enabling (also runnable as `pnpm --filter backend db:reencrypt-content`).
  - Once content has been encrypted, startup fails — deliberately with no override — if the key is missing or wrong, because chat history and logs cannot be re-entered.
  - See [Content Encryption at Rest](/docs/platform-content-encryption) for the enable and rotation procedures.
- **`ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY`** - Enables [locked chats](/docs/platform-content-encryption#locked-chats): conversations, and the audit records they produce, encrypted under a browser-held per-conversation key the server never stores. The value is the RSA public key (PEM or base64-of-PEM, >= 2048 bits) each chat key is escrowed to for break-glass recovery. The wrapped key is stored on the conversation row; the private half stays offline with your security team, and without it the stored copy is useless.
  - Default: not set — locked chats are unavailable. Unsetting it later turns the feature off again.
  - Escrow is required, not optional: a locked chat encrypts its own audit trail, so without an escrowed key those records could be read by nobody.
  - Startup fails when the value is not a valid RSA public key of at least 2048 bits.
  - Set it in its own rollout, after the release is deployed, so no replica writes a record an older one cannot read.
  - This variable was called `ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY` before the feature was renamed. The old name still works, so you can rename it on your own schedule.
  - See [Locked Chats](/docs/platform-content-encryption#locked-chats) for setup and the recovery procedure.
- **`ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS`** - Additional decrypt-only content key. Set during rotation (old key here, new key above) while the background sweep re-encrypts, and during rolling enablement to make every replica envelope-capable before writes activate. Unset it once the sweep completes.

- **`ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS`** - The previous encryption secret, read only by the startup re-encryption to decrypt rows written under the prior key. When unset it defaults to the deployment's prior secret, so existing installs re-encrypt automatically on the first restart with the new key. Unset it once re-encryption has completed.

  > When using an external `authSecret.existingSecretName`, that Secret must include `session-secret` and `secrets-encryption-secret` keys (add them before upgrading). Rotate by updating a key in your own secret manager.

- **`ARCHESTRA_AUTH_ADMIN_EMAIL`** - Email address for the default Archestra Admin user, created on startup.
  - Default: `admin@example.com`

- **`ARCHESTRA_AUTH_ADMIN_PASSWORD`** - Password for the default Archestra Admin user. Set once on first-run.
  - Default: `password`
  - Note: Change this to a secure password for production deployments

- **`ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL`** - Developer-only convenience that skips the login screen by minting a real session for the user with this email when the app loads unauthenticated.
  - Default: None (disabled)
  - Ignored in production (`NODE_ENV=production` or `prod`); only takes effect in development builds
  - The session is an ordinary one for that user — role-based access control is unchanged
  - Example: `admin@example.com`

- **`ARCHESTRA_AUTH_COOKIE_DOMAIN`** - Scopes the session cookie to a domain so the frontend and backend can share it.
  - Default: None. The cookie stays host-only, bound to the exact frontend host.
  - Set this only when your frontend and backend are on different subdomains. Use the narrowest domain that covers both. For a frontend at `https://frontend.example.com` and a backend at `https://backend.example.com`, set `example.com`.
  - The browser then sends the cookie to _every_ subdomain of that domain, not just those two. So `example.com` also reaches `other.example.com`.
  - Warning: this is how one instance breaks another. If a second Archestra runs on a sibling subdomain (`staging.example.com`) and both use the default cookie prefix, their session cookies share a name and collide. The browser sends both, the server reads the wrong one, and login silently bounces back to the sign-in page.
  - To run more than one instance under the same domain, give each a unique `ARCHESTRA_AUTH_COOKIE_PREFIX` (below). Do this even when only one instance sets a cookie domain — the shared cookie still leaks to the others.

- **`ARCHESTRA_AUTH_COOKIE_PREFIX`** - Prefix for auth cookie names (`<prefix>.session_token`, etc.).
  - Default: `archestra`
  - Give each instance that shares a host or domain with another a unique prefix, so their session cookies have distinct names and never collide.
  - Two cases need this. Instances on different ports of one host: browsers ignore the port, so the cookies overwrite each other. Instances on sibling subdomains where one sets `ARCHESTRA_AUTH_COOKIE_DOMAIN`: that cookie leaks across the whole domain (see above).
  - A single, isolated deployment can leave the default.

- **`ARCHESTRA_AUTH_DISABLE_BASIC_AUTH`** - Hides the username/password login form on the sign-in page.
  - Default: `false`
  - Set to `true` to disable basic authentication and require users to authenticate via SSO only
  - Note: Configure at least one Identity Provider before enabling this option. See [Identity Providers](/docs/platform-identity-providers) for SSO configuration.

- **`ARCHESTRA_AUTH_DISABLE_IMPERSONATION`** - Disables user impersonation ("View as user" role debugging).
  - Default: `false`
  - Set to `true` to hide the impersonation pickers and refuse new impersonated sessions
  - Leaving it `false` does not grant impersonation to everyone — it still requires the `member:impersonate` permission (see [Available Permissions](/docs/platform-access-control#available-permissions))

- **`ARCHESTRA_AUTH_DISABLE_INVITATIONS`** - Disables user invitations functionality.
  - Default: `false`
  - Set to `true` to hide invitation-related UI and block invitation API endpoints
  - When enabled, administrators cannot create new invitations, and the invitation management UI is hidden
  - Useful for environments where user provisioning is handled externally (e.g., via SSO with automatic provisioning)

- **`ARCHESTRA_AUTH_DCR_ENABLED`** - Controls OAuth Dynamic Client Registration (DCR, RFC 7591) and CIMD auto-registration.
  - Default: `true`
  - Set to `false` to allow only pre-registered OAuth clients to run OAuth flows. Runtime self-registration (`POST /api/auth/oauth2/register`) returns `403`, CIMD auto-registration is skipped, and the well-known metadata stops advertising the registration endpoint
  - Pair with manually registered [MCP OAuth clients](/docs/mcp-authentication) (both `client_credentials` and `authorization_code`) when you want to restrict gateway access to a known set of applications

- **`ARCHESTRA_AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS`** - Grace window for the OAuth refresh-token replay shield, in seconds.
  - Default: `60`
  - Refresh tokens are single-use and rotated. When a client replays an already-rotated refresh token within this window, it is treated as a benign rotation race (e.g. a token-exchange response lost when the backend restarted, then retried by the client) and a fresh token pair is re-issued, rather than triggering reuse invalidation. A replay after the window is treated as reuse and invalidates that grant
  - Set to `0` to disable the grace window and treat every replay as reuse immediately
  - Raising it widens the window in which a replayed token is re-issued rather than rejected; lowering it tightens reuse detection at the cost of recovering fewer benign races

- **`ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS`** - Extra trusted origins for CORS and authentication, in addition to `ARCHESTRA_FRONTEND_URL`. Setting this variable (even without `ARCHESTRA_FRONTEND_URL`) enables origin validation.
  - Default: None (origin validation is off when neither this nor `ARCHESTRA_FRONTEND_URL` is set)
  - Format: Comma-separated list of origins (e.g., `http://idp.example.com:8080,https://auth.example.com`)
  - Use this to trust external identity providers (IdPs) for SSO, or to allow access from multiple URLs (e.g., both a LAN IP and a domain name)
  - Example for LAN access alongside localhost: `http://192.168.1.5:3000,http://192.168.1.5:9000`

- **`ARCHESTRA_SECRETS_MANAGER`** - Secrets storage backend for managing sensitive data (API keys, tokens, etc.)
  - Default: `DB` (database storage)
  - Options: `DB`, `VAULT`, or `READONLY_VAULT`
  - Note: When set to `VAULT` or `READONLY_VAULT`, requires `ARCHESTRA_HASHICORP_VAULT_ADDR` and the credentials for the selected auth method. See [Secrets Management](/docs/platform-secrets-management) for the full configuration reference (KV version, secret path prefix, auth methods).

- **`ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY`** - One-boot escape hatch after a deliberate encryption-secret change made without the re-encryption migration.
  - Default: `false`
  - Startup aborts when the current encryption secret cannot decrypt previously stored secrets. Set to `true` for one boot to accept the new key, then unset it.
  - Secrets encrypted with the previous key stay unreadable — re-enter them after the change. To keep them, use `ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS` and the re-encryption migration instead.

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

These environment variables set the default base URL for each LLM provider. Per-key base URLs configured in **Model Providers** take precedence over these defaults. See [LLM Proxy Authentication](/docs/platform-llm-proxy-authentication) for details on per-key base URLs and virtual API keys.

- **`ARCHESTRA_OPENAI_BASE_URL`** - Override the OpenAI API base URL.
  - Default: `https://api.openai.com/v1`
  - Use this to point to your own proxy, an OpenAI-compatible API, or other custom endpoints

- **`ARCHESTRA_OPENAI_CODEX_API_BASE_URL`** - Codex backend serving the ChatGPT-subscription Responses API.
  - Default: `https://chatgpt.com/backend-api/codex`
- **`ARCHESTRA_OPENAI_CODEX_ISSUER`** - OAuth issuer hosting the ChatGPT authorize, token, and device endpoints.
  - Default: `https://auth.openai.com`
- **`ARCHESTRA_OPENAI_CODEX_CLIENT_ID`** - Public OAuth client id for the ChatGPT/Codex sign-in.
  - Default: the Codex CLI client id
- **`ARCHESTRA_OPENAI_CODEX_ORIGINATOR`** - `originator` header the Codex backend attributes traffic by. Override to `codex_cli_rs` if OpenAI ever restricts unknown originators.
  - Default: `archestra`

- **`ARCHESTRA_ANTHROPIC_BASE_URL`** - Override the Anthropic API base URL.
  - Default: `https://api.anthropic.com`
  - Use this to point to your own proxy or other custom endpoints

- **`ARCHESTRA_ANTHROPIC_AZURE_FOUNDRY_ENTRA_ID_ENABLED`** - Enable Microsoft Entra ID authentication for Anthropic models deployed in Microsoft Foundry.
  - Default: `false`
  - Set `ARCHESTRA_ANTHROPIC_BASE_URL=https://<resource-name>.services.ai.azure.com/anthropic`
  - Uses Azure Identity `DefaultAzureCredential` with token scope `https://ai.azure.com/.default`
  - Claude deployments must already exist in the Azure resource. Microsoft lists additional Claude prerequisites: paid eligible subscription, supported region, Azure Marketplace access for partner models, permission to subscribe to model offerings, and Contributor or Owner role on the resource group. Azure also requires Anthropic deployment metadata: `industry`, `organizationName`, and `countryCode`.

- **`ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID`**, **`ARCHESTRA_ANTHROPIC_ORGANIZATION_ID`**, **`ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID`** - Enable keyless Anthropic authentication via [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation).
  - All three are required, plus one identity token source (below). A partial configuration logs a warning at startup and disables WIF.
  - Values come from the federation rule (`fdrl_...`), organization ID, and service account (`svac_...`) created in the Claude Console under **Settings → Workload identity**.

- **`ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE`** - Path to the OIDC identity token file issued by your identity provider (e.g. a Kubernetes projected service-account token).
  - Example: `/var/run/secrets/anthropic.com/token`
  - Re-read on every token exchange, so rotated tokens are picked up automatically. Prefer this over the inline variant in production.

- **`ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN`** - Inline OIDC identity token; alternative to `ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE`.
  - Identity tokens are short-lived, so this is mainly useful for testing. The file variant takes precedence when both are set.

- **`ARCHESTRA_ANTHROPIC_WORKSPACE_ID`** - Anthropic workspace ID (`wrkspc_...`) for Workload Identity Federation.
  - Optional; required only when the federation rule covers more than one workspace.

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

- **`ARCHESTRA_XAI_SUBSCRIPTION_ISSUER`** - OAuth issuer for the SuperSuperGrok sign-in. Its OIDC discovery document supplies the device and token endpoints.
  - Default: `https://auth.x.ai`
- **`ARCHESTRA_XAI_SUBSCRIPTION_VERIFICATION_ORIGIN`** - Allowed browser origin for the device-flow verification page. Responses pointing elsewhere are rejected.
  - Default: `https://accounts.x.ai`
- **`ARCHESTRA_XAI_SUBSCRIPTION_CLIENT_VERSION`** - Tested xAI session-protocol version reported to the proxy. Update this deliberately when adopting a newer proxy contract.
  - Default: `1.0.0`
- **`ARCHESTRA_XAI_SUBSCRIPTION_BASE_URL`** - OpenAI-compatible inference and model endpoint for SuperGrok OAuth sessions.
  - Default: `https://cli-chat-proxy.grok.com/v1`
  - This is separate from the metered `ARCHESTRA_XAI_BASE_URL` API-key endpoint
- **`ARCHESTRA_XAI_SUBSCRIPTION_CLIENT_ID`** - Public OAuth client id for the SuperGrok device-code login.
  - Default: the public Grok CLI client id
- **`ARCHESTRA_XAI_SUBSCRIPTION_SCOPES`** - Space-separated scopes requested at device-authorization time. Drop `grok-cli:access` if xAI refuses it for your accounts; `offline_access` is required, since it is what yields the refresh token the key stores.
  - Default: `openid profile email offline_access api:access grok-cli:access`

- **`ARCHESTRA_OPENROUTER_BASE_URL`** - Override OpenRouter API base URL.
  - Default: `https://openrouter.ai/api/v1`
  - Use this to point to your own proxy, an OpenRouter-compatible API, or other custom endpoints

- **`ARCHESTRA_VLLM_BASE_URL`** - Base URL for your OpenAI-compatible server (vLLM, llama.cpp, LM Studio, SGLang, TGI, LocalAI).
  - Required to enable the OpenAI-compatible provider
  - Example: `http://localhost:8000/v1` (standard vLLM)
  - See: [OpenAI-compatible setup guide](/docs/platform-supported-llm-providers#openai-compatible-servers)

- **`ARCHESTRA_OLLAMA_BASE_URL`** - Base URL for your Ollama server.
  - Default: `http://localhost:11434/v1` (Ollama is enabled by default)
  - Set this to override the default if your Ollama server runs on a different host or port
  - See: [Ollama setup guide](/docs/platform-supported-llm-providers#ollama)

- **`ARCHESTRA_OLLAMA_NATIVE_BASE_URL`** - Base URL for the "Ollama (Native)" provider, which uses Ollama's native `/api/chat` endpoint.
  - Default: `ARCHESTRA_OLLAMA_BASE_URL` with the `/v1` suffix stripped (`http://localhost:11434`)
  - Set this only if the native endpoint runs on a different host than the OpenAI-compatible one
  - This is the server **root** — do not include a `/v1` suffix
  - See: [Ollama setup guide](/docs/platform-supported-llm-providers#ollama)

- **`ARCHESTRA_DEEPSEEK_BASE_URL`** - Override the DeepSeek API base URL.
  - Default: `https://api.deepseek.com`
  - Use this to point to your own proxy or other custom endpoints

- **`ARCHESTRA_ARCHESTRA_BASE_URL`** - Global upstream base URL for the Archestra provider (another Archestra instance's LLM proxy).
  - No default; normally set per key in the UI
  - A global value only enables raw passthrough at the `/v1/archestra` proxy prefix
  - See: [Archestra provider setup](/docs/platform-supported-llm-providers#archestra)

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

- **`ARCHESTRA_MICROSOFT_365_COPILOT_CLIENT_ID`** - Application (client) ID of your Entra app registration for the Microsoft 365 Copilot device flow.
  - No default. The "Sign in with Microsoft" flow is unavailable until this is set.
  - The registration needs public client flows enabled and admin-consented delegated Graph scopes (see [Supported LLM Providers](/docs/platform-supported-llm-providers))

- **`ARCHESTRA_MICROSOFT_365_COPILOT_TENANT_ID`** - Entra tenant segment of the OAuth endpoints used for Microsoft 365 Copilot sign-in and token redemption.
  - Default: `organizations` (any work or school account)
  - Pin your tenant id to restrict sign-in to one directory

- **`ARCHESTRA_MICROSOFT_365_COPILOT_BASE_URL`** - Override the Microsoft Graph base URL serving the Microsoft 365 Copilot Chat API.
  - Default: `https://graph.microsoft.com/beta`

- **`ARCHESTRA_MICROSOFT_365_COPILOT_AUTH_BASE_URL`** - Entra ID host serving the OAuth device-flow and token endpoints.
  - Default: `https://login.microsoftonline.com`
  - Microsoft 365 Copilot has no static API keys: provider keys store the user's long-lived Entra refresh token, and the proxy redeems it (with caching) on every request

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

- **`ARCHESTRA_LLM_COST_SUBSCRIPTION_AUTODETECT`** - Automatically classify subscription credentials as subscription usage.
  - Default: `true`
  - When on, traffic fulfilled by a subscription credential — detected from the credential format, e.g. Anthropic `sk-ant-oat…` OAuth tokens from a Claude Max/Pro login — is recorded as `subscription` billing mode and reported as $0 billed spend, keeping its list-price estimate for comparison
  - Anthropic responses fulfilled from paid usage credits after a Max/Pro allowance is exhausted are reclassified as `metered` from the upstream rate-limit headers, because those requests are charged at API rates
  - Set to `false` to treat all traffic as metered
  - See: [Costs and Limits](/docs/platform-costs-and-limits#subscription-vs-metered-cost)

- **`ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED`** - Enable AWS IAM authentication for Bedrock.
  - Default: `false`
  - Set to `true` to use the AWS credential chain (IRSA, instance profiles, env vars) instead of API keys
  - See: [Bedrock IAM setup guide](/docs/platform-supported-llm-providers#iam-authentication-setup-irsa)

- **`ARCHESTRA_BEDROCK_REGION`** - Explicit AWS region for Bedrock.
  - Optional: Falls back to extracting from `ARCHESTRA_BEDROCK_BASE_URL`, then to `us-east-1`
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

- **`ARCHESTRA_GEMINI_VERTEX_AI_ALLOW_GLOBAL_ENDPOINT`** - Use Vertex AI's global endpoint for models that only it serves.
  - Default: `false`
  - Vertex AI serves Gemini 3 and newer generations only from `global`. A request pinned to an ordinary region returns 404, so those models stay out of the model catalog while this is off.
  - Set to `true` to reach them. Models the configured region serves — Gemma, `gemini-embedding-001`, the Gemini 2.5 family — keep using `ARCHESTRA_GEMINI_VERTEX_AI_LOCATION`.
  - Leave it off when the region was chosen for data residency. The global endpoint routes to any region, and you cannot control or see which one handles a request.
  - Has no effect when `ARCHESTRA_GEMINI_VERTEX_AI_LOCATION` is already `global`.

- **`ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE`** - Path to Google Cloud service account JSON key file.
  - Optional: Only needed when running outside of GCP or without Workload Identity
  - Example: `/path/to/service-account-key.json`
  - When not set, uses [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials)
  - See: [Vertex AI setup guide](/docs/platform-supported-llm-providers#using-vertex-ai)

- **`ARCHESTRA_CHAT_<PROVIDER>_API_KEY`** - LLM provider API keys for the built-in Chat feature.
  - Supported `<PROVIDER>` values: `ANTHROPIC`, `OPENAI`, `OPENROUTER`, `GEMINI`, `CEREBRAS`, `COHERE`, `GROQ`, `XAI`, `MISTRAL`, `PERPLEXITY`, `VLLM`, `OLLAMA`, `ZHIPUAI`, `DEEPSEEK`, `ARCHESTRA`, `GITHUB_COPILOT`, `BEDROCK`, `MINIMAX`, `AZURE_OPENAI`
  - These serve as fallback API keys when no organization default or profile-specific key is configured
  - Note: `ARCHESTRA_CHAT_VLLM_API_KEY` and `ARCHESTRA_CHAT_OLLAMA_API_KEY` are optional as most vLLM/Ollama deployments don't require authentication
  - Note: there is no separate `OLLAMA_NATIVE` value — the "Ollama (Native)" provider reads `ARCHESTRA_CHAT_OLLAMA_API_KEY`, since both providers talk to the same server
  - Note: `ARCHESTRA_CHAT_GITHUB_COPILOT_API_KEY` holds a GitHub OAuth token (`gho_...`) of an account with a Copilot subscription, not a static API key
  - See [Chat](/docs/platform-chat) for full details on API key configuration and resolution order

- **`ARCHESTRA_CHAT_DEFAULT_PROVIDER`** - Default LLM provider for Chat and A2A features.
  - Default: `anthropic`
  - Options: `anthropic`, `openai`, `gemini`
  - Used when no profile-specific provider is configured

Active chat run wake-ups use Postgres `LISTEN/NOTIFY` by default. This gives fast reconnect replay and Stop handling without waiting for the fallback poll interval. Poll intervals still exist in this mode as a safety net, so missed notifications or broken listener connections do not block progress forever.

Chat streams and A2A task streams are woken by Postgres `LISTEN/NOTIFY`, which works across replicas. You do not have to tell the platform whether your database endpoint supports it: on connect, it sends itself a notification and checks whether it arrives. Until one does, it polls more often so Stop and replay stay responsive. Streams read from the database either way, so a missed notification costs latency, never correctness.

Set the variables below only to tune load or to skip the listener entirely.

- **`ARCHESTRA_CHAT_ACTIVE_RUN_REPLAY_POLL_INTERVAL_MS`** - Fallback/poll interval for replaying active chat runs after reconnect.
  - Default: `500`
  - Load model: roughly one replay-check read per reconnecting client per interval while waiting for new events

- **`ARCHESTRA_CHAT_ACTIVE_RUN_STOP_POLL_INTERVAL_MS`** - Fallback interval for checking whether a running chat stream has been stopped.
  - Default: `30000`
  - Stop requests normally wake streams immediately, so this is the safety net for a missed notification. When notifications are not arriving, the platform ignores this value and checks every 500ms instead
  - Load model: roughly one stop-check read per running chat stream per interval

- **`ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED`** - Skips the listener connection entirely and relies on polling.
  - Default: `false`
  - You rarely need this. The platform detects an endpoint that cannot deliver notifications and adjusts on its own; set it only to avoid holding a listener connection you know will never work
  - Also covers A2A task streams, which share the same wake-up mechanism

- **`ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL`** - Optional Postgres connection string for active chat run `LISTEN/NOTIFY`.
  - Default: Uses `ARCHESTRA_DATABASE_URL`
  - Set this when regular database traffic goes through PgBouncer transaction pooling but notifications can use a direct or session-pooled connection
  - A2A task streams use this connection too

- **`ARCHESTRA_CHAT_SECRET_SCAN_ENABLED`** - Enables client-side pre-send scanning of chat messages for secrets and high-entropy tokens.
  - Default: `true`
  - When enabled, the chat composer intercepts sends and shows a confirmation dialog when the message appears to contain credentials (API keys, tokens, passwords, JWTs, PEM keys, or high-entropy strings). Set to `false` to disable.
  - This is a client-side convenience nudge, not a data-loss-prevention control: it runs in the browser and can be bypassed with "Send anyway".
  - Detection runs entirely in the browser — no message content is sent to the backend for scanning. The flag is read from the backend at runtime via `/api/config`, so toggling it does not require a frontend rebuild.
  - Values: `true`, `false`

- **`ARCHESTRA_CHAT_ATTACHMENT_STORAGE_BYTES_LIMIT`** - Largest single file a chat upload may store as a conversation attachment.
  - Default: `52428800` (50 MiB)
  - This is the only size gate on a chat upload. A file the model cannot read, one too big for the sandbox, or one over `ARCHESTRA_CHAT_ATTACHMENT_INLINE_BYTES_LIMIT` is not rejected: it is stored in the conversation's Files panel, where the user can download it, and the agent is told it is there.
  - Raise `ARCHESTRA_API_BODY_LIMIT` alongside this. Uploads arrive base64-encoded (about 4/3 the byte size) in the same request as the conversation history, so the body limit must exceed this value by a comfortable margin.

- **`ARCHESTRA_CHAT_ATTACHMENT_INLINE_BYTES_LIMIT`** - Largest single attachment that may be embedded in a request to the LLM provider.
  - Default: `16777216` (16 MiB)
  - Storing a file and sending it to a model are separate decisions. A file above this is still stored and downloadable; it just never reaches the model, so a large upload cannot inflate a request past what the provider accepts.
  - The effective ceiling is the lower of this value and the provider's own documented request limit (Anthropic 32 MiB, Bedrock 20 MiB).

- **`ARCHESTRA_CHAT_MAX_OUTPUT_TOKENS`** - Upper bound on the output tokens an agent turn (interactive chat and A2A/headless) may generate.
  - Default: `32768`
  - Each turn already requests the model's real output ceiling instead of the provider/SDK default that truncated large tool-call payloads and final submission turns. This variable caps that request for cost control: the turn uses `min(this value, the model's real output ceiling)`, and unsynced models fall back to `8192`.
  - Lower it to constrain spend; raise it for models whose useful outputs exceed 32768 tokens.

- **`ARCHESTRA_CHAT_RATE_METERED_MAX_OUTPUT_TOKENS`** - Output-token cap applied only to providers that charge a request's `max_tokens` reservation against a per-minute token bucket (currently Groq).
  - Default: `4096`
  - These providers bill the prompt plus the reserved output budget up front, so requesting a model's real output ceiling can exceed the entire per-minute allowance on an entry tier. The request is then rejected with a 413 before generating a token, and because the reservation is constant, shortening the conversation or starting a new chat does not help.
  - The turn uses `min(ARCHESTRA_CHAT_MAX_OUTPUT_TOKENS, this value, the model's real output ceiling)` for affected providers; every other provider is unchanged.
  - Raise it on higher provider tiers, whose larger buckets leave room for longer generations. The cost of this cap is truncated long outputs; the cost of removing it on a small tier is that every request fails.

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

### A2A Gateway

A2A task streams work across replicas. A client can subscribe on one replica while the task runs on another — the stream reads the task's event log from the database, and Postgres `LISTEN/NOTIFY` wakes it as soon as the running replica writes. If a notification is missed, the stream falls back to a periodic read, so it stays correct either way. Behind a connection pooler that cannot hold a listener, set `ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED`.

- **`ARCHESTRA_A2A_TASK_RETENTION_DAYS`** - How long a finished A2A task is kept before it is deleted, along with its artifacts and stream events.
  - Default: `90`. Set to `0` to keep tasks forever.
  - Only terminal tasks (completed, failed, canceled, rejected) are eligible; a task still running is never deleted.
  - The task's messages are detached before it goes, so the conversation history they belong to is untouched — only the task-scoped view of them is lost. The agent's answer also stays in that history.
  - Deletion runs in bounded batches on the same background sweep that reaps orphaned tasks, so a large backlog is worked down over several passes.

### MCP Gateway

- **`ARCHESTRA_MCP_GATEWAY_TOOL_CALL_TIMEOUT_MS`** - Per-request timeout, in milliseconds, for an upstream MCP tool call made through the gateway.
  - Default: `60000` (60 seconds)
  - Raise it for tools that take a long time to run — a slow scraper or report builder, for example — that otherwise fail with a request-timeout error.
- The MCP Tasks threshold — how long a call from a Tasks-capable client runs synchronously before becoming a background task — derives from this value: half of it, capped at 10 seconds. Task executions themselves are bounded by the 30-minute task retention window, not this timeout.
- **`ARCHESTRA_MCP_SKILLS_ENABLED`** - Beta gate for both directions of the draft MCP Skills extension (SEP-2640): publishing local Skills through gateways and projecting Skills discovered from installed MCP servers.
  - Default: unset (falls back to `ARCHESTRA_BETA`)
  - An explicit `false` keeps both directions off even when the master beta switch is enabled.
  - See [Publishing Skills over MCP](/docs/platform-mcp-gateway-skills) and [Skills from MCP servers](/docs/platform-agent-skills#skills-from-mcp-servers).

### MCP Servers

- **`ARCHESTRA_MCP_SERVER_TOOLS_REFRESH_INTERVAL_MINUTES`** - Opt-in periodic re-discovery of installed MCP servers' tools and Skills metadata. Every N minutes, each installed server's stored listing is re-synced from the live server — new entries are added, changed metadata is updated, and removed entries are dropped. No restart or reinstall happens. Tool assignments and policies are preserved; Skill content is always read live rather than copied.
  - Default: unset (disabled). Set to `0` to disable explicitly.
  - Example: `30`
  - Tools can also be refreshed on demand: from the server's Inspector tab in the MCP Registry, or via `POST /api/mcp_server/:id/reload-tools`.

- **`ARCHESTRA_MCP_SERVER_ALERTING_ENABLED`** - Beta gate for MCP Registry attention ordering, issue diagnostics, ownership guidance, and per-viewer alert dismissal.
  - Default: `false`
  - A blank value falls back to the `ARCHESTRA_BETA` master switch. An explicit `false` keeps alerting and its dismissal APIs hidden even when the master switch is enabled.

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

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_CPU_REQUEST`** - CPU request for generated MCP server containers, as a Kubernetes quantity.
  - Default: `50m`

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_MEMORY_REQUEST`** - Memory request for generated MCP server containers.
  - Default: `128Mi`

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_MEMORY_LIMIT`** - Memory limit for generated MCP server containers.
  - Default: `512Mi`

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_EPHEMERAL_STORAGE_REQUEST`** - Ephemeral-storage request for generated MCP server containers. Keeps the Kubernetes scheduler aware of disk usage so nodes are not over-packed into DiskPressure evictions.
  - Default: `256Mi`

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_EPHEMERAL_STORAGE_LIMIT`** - Ephemeral-storage limit for generated MCP server containers.
  - Default: `1Gi`

- **`ARCHESTRA_ORCHESTRATOR_FAILED_POD_REAP_INTERVAL_SECONDS`** - How often the platform deletes Failed or Evicted MCP server pods left behind by node-pressure evictions.
  - Default: `600`
  - Set to `0` to disable.

- **`ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_ENABLED`** - Offers idle hibernation on this deployment. Hibernation is a beta feature and ships off by default.
  - Default: unset (falls back to the `ARCHESTRA_BETA` master switch)
  - Set to `true` to offer the feature; an explicit `false` keeps it off even with `ARCHESTRA_BETA` on.
  - Organizations still enable it in **Settings > MCP**; it requires an Enterprise license.

- **`ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_SECONDS`** - How long an MCP server pod can sit unused before the platform hibernates it, with nonzero values floored at 120 seconds so servers are never hibernated between normal consecutive tool calls.
  - Default: `1800` (30 minutes)
  - Sets the idle window only. Enable hibernation in **Settings > MCP**; it requires an Enterprise license.
  - Set to `0` to disable hibernation platform-wide, regardless of the organization setting.

- **`ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_ENABLED`** - Caches MCP server images on every node with a DaemonSet, so hibernated servers wake without calling the container registry.
  - Default: `true`
  - Only runs while idle hibernation is enabled; set to `false` to stop pre-pulling and keep hibernation.
  - The DaemonSet takes a pod slot on every node the MCP servers can be scheduled on.

- **`ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_BOOTSTRAP_IMAGE`** - Image for the pre-pull DaemonSet's own containers.
  - Default: `docker.io/library/busybox:1.36-musl`.
  - The image must provide a statically linked `/bin/busybox`. The DaemonSet copies it into MCP images that may use another libc.
  - Independent of the MCP server base image on purpose, so a pinned or custom base image cannot break pre-pulling.
  - Point it at a static private mirror when your cluster cannot pull from Docker Hub.

- **`ARCHESTRA_ORCHESTRATOR_MCP_RUNTIME_OWNER_ROLE`** - Same-namespace Role used to remove runtime-created MCP resources on uninstall.
  - The chart creates and sets a dedicated Role when it manages orchestrator RBAC.
  - With external RBAC, use a readable Role with the same name in every runtime namespace.
  - Delete each external Role during uninstall to remove its runtime resources.

- **`ARCHESTRA_ORCHESTRATOR_HELM_RELEASE_NAME`** - Names the cluster objects Archestra creates for itself outside the chart, such as the image pre-pull DaemonSet.
  - Default: injected by the Helm chart. Set it by hand only when you deploy without the chart.
  - Two releases can then share a namespace without fighting over one object.
  - When it is unset, those objects are not created at all.

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
  - Default: `true` (enabled) — **unless [content encryption at rest](/docs/platform-content-encryption) is configured, in which case the default flips to `false`**: exporting the same content in plaintext to a telemetry backend would bypass the at-rest guarantee. Setting `true` explicitly still enables capture (for telemetry pipelines protected to the same standard) and logs a startup warning.
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

- **`ARCHESTRA_RUM_EXPORTER_OTLP_ENDPOINT`** - OTLP endpoint for [Real User Monitoring](/docs/platform-observability#real-user-monitoring) export. Product-usage events from the web UI go to this collector as OTLP log records. Requires an active [enterprise license](/docs/platform-pricing-model); the backend refuses to start when this is set without one.
  - Default: unset (RUM is off)
  - Setting the endpoint turns the feature on

- **`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_USERNAME`** - Username for RUM export basic authentication.
  - Optional: Only used if both username and password are provided

- **`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_PASSWORD`** - Password for RUM export basic authentication.
  - Optional: Only used if both username and password are provided

- **`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_BEARER`** - Bearer token for RUM export authentication.
  - Optional: Takes precedence over basic authentication if provided

- **`ARCHESTRA_RUM_SAMPLE_RATE`** - Fraction of RUM sessions to record, 0 to 1. Whole sessions are kept or skipped, so funnels stay coherent. Client errors are always reported.
  - Default: 1 (record every session)

- **`ARCHESTRA_RUM_EXPORTER_MAX_QUEUE_SIZE`** / **`ARCHESTRA_RUM_EXPORTER_MAX_EXPORT_BATCH_SIZE`** / **`ARCHESTRA_RUM_EXPORTER_SCHEDULE_DELAY_MS`** - RUM OTLP batch tuning. Raise batch size and lower the delay for deployments with thousands of concurrent users. Export uses gzip.
  - Defaults: 2048 / 512 / 5000

- **`ARCHESTRA_RUM_INGEST_MAX_BATCHES_PER_MINUTE`** - How many RUM event batches one user may submit per minute. Batches over the limit are rejected and their events dropped.
  - Default: 120

- **`ARCHESTRA_METRICS_PORT`** - TCP port for the metrics server.
  - Default: `9050`
  - Must be an integer between `1` and `65535`; invalid values fall back to the default with a warning

- **`ARCHESTRA_METRICS_SECRET`** - Bearer token for authenticating metrics endpoint access.
  - Default: `archestra-metrics-secret`
  - Note: When set, clients must include `Authorization: Bearer <token>` header to access `/metrics`

- **`ARCHESTRA_METRICS_ACTIVE_USERS_REFRESH_INTERVAL_MS`** - How often, in milliseconds, to recompute the `llm_active_users` gauge.
  - Default: `300000` (5 minutes)
  - Set to `0` to disable collection entirely
  - Values below `30000` are raised to that floor: the gauge is a distinct count over the interactions table, so a short interval turns into steady background load for a number that changes slowly

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

- **`ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED`** - Opt-out switch for the welcome message sent to auto-provisioned chatops users.
  - Default: `true`
  - `false` skips the welcome entirely. Use it when your chatops users don't get web app access. Users are still auto-provisioned.
  - When an SSO identity provider is configured, the welcome carries a sign-in link instead of the finish-signup link.
  - Without SSO, the welcome is skipped automatically when the finish-signup flow is unavailable — `ARCHESTRA_AUTH_DISABLE_INVITATIONS` or `ARCHESTRA_AUTH_DISABLE_BASIC_AUTH` set to `true`.

#### Microsoft Teams

- **`ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED`** - Enable Microsoft Teams integration.
  - Default: `false`
  - Set to `true` to enable the MS Teams chatops provider

- **`ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID`** - Azure Bot App ID (Client ID).
  - Required when: `ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true`
  - Example: `88888dd-d6a1-4fd6-8783-b2f4931be17b`
  - This is the Application (client) ID from your Azure Bot registration

- **`ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET`** - Azure Bot App Secret (Client Secret).
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

To expose the MS Teams incoming webhook on a dedicated port instead of the main API port, see [`ARCHESTRA_PUBLIC_ENDPOINTS_PORT`](#application--api-configuration).

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

#### Telegram

See [Telegram](/docs/platform-telegram) for setup instructions. Telegram uses long polling — no public URL, webhook, or ngrok needed.

- **`ARCHESTRA_CHATOPS_TELEGRAM_ENABLED`** - Opt-out switch for the Telegram integration.
  - Default: `true` (the channel is available on every deployment)
  - `false` hides the Telegram channel and the provider never starts

- **`ARCHESTRA_CHATOPS_TELEGRAM_BOT_TOKEN`** - Bot token issued by [@BotFather](https://t.me/BotFather).
  - Optional: the token can also be saved from the Telegram channel page
  - Format: `123456789:ABC...`

#### Attachment processing

- **`ARCHESTRA_CHATOPS_MAX_CONCURRENT_FILE_TRANSFERS`** - Per-process cap on concurrent chatops attachment downloads and image shrinking.
  - Default: `4`
  - Bounds the transient memory a burst of attachment-heavy messages can hold; lower it on memory-constrained deployments
  - Currently applies to Slack downloads only; MS Teams has no image-shrink path and enforces a flat 10 MB per-file cap instead

### Knowledge Base Configuration

These environment variables configure the [Knowledge Base](/docs/platform-knowledge). Knowledge Bases use a built-in RAG stack powered by pgvector for document chunking, embedding, and hybrid search.

- **Embedding and reranker API keys** are configured via LLM Provider Keys in **Settings > Knowledge**, not via environment variables. See [Embedding Configuration](/docs/platform-knowledge#embedding-configuration) and [Search Ranking Configuration](/docs/platform-knowledge#search-ranking-configuration) for how to pick the key and model.

- **`ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_SYNC_MAX_DURATION_SECONDS`** - Max wall-clock time a single connector sync run works before it checkpoints and yields.
  - Default: `3300` (55 minutes)
  - Bounds how long one run holds a worker and chunks large syncs into resumable pieces. When a run exceeds ~90% of this budget it stops, is marked `partial`, and enqueues a continuation that resumes from the last checkpoint. Set to `0` to disable (a run then goes to completion in a single pass). Liveness is enforced separately by the lease/heartbeat below, not by this budget.

- **`ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_RUN_LEASE_TTL_SECONDS`** - Liveness-lease window for a connector sync run.
  - Default: `300` (5 minutes)
  - The worker running a sync renews the run's lease throughout its life (ingest and embedding drain). A run whose lease is not renewed within this window is treated as crashed/hung and reclaimed — its status becomes `partial` and it resumes from its checkpoint. Keep this several times the heartbeat interval so a single missed renewal (GC pause, slow batch) does not falsely expire a healthy run.

- **`ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_RUN_HEARTBEAT_INTERVAL_SECONDS`** - How often the owning worker renews a run's lease.
  - Default: `90` (seconds)

- **`ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_SOURCE_REF`** - Development override for where the Archestra VAF Add On install script gets the add-on.
  - Default: unset (the script uses the pre-built package of the newest `m-files-vaf-add-on-v*` release)
  - Set a git ref of `archestra-ai/archestra` (a pushed commit SHA, branch, or tag) to have the script install that ref's CI-built package, or compile from that ref's source when no CI build exists. The special value `local` uses the backend checkout's HEAD commit. Leave unset in production.

- **`ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_GITHUB_TOKEN`** - GitHub token used to fetch the source ref's CI-built add-on package.
  - Default: unset
  - GitHub requires authentication for Actions artifact downloads, even on public repositories. Only read when the source-ref override is set; without a token the install script compiles the add-on from source. The backend proxies the package — the token never reaches clients.

- **`ARCHESTRA_KNOWLEDGE_BASE_STALLED_EMBEDDING_AGE_SECONDS`** - How long a document may sit un-embedded before the recovery sweep re-enqueues it.
  - Default: `900` (15 minutes)
  - An embedding job that fails permanently leaves its documents stuck. This window is the worst-case wait before the sweep re-embeds them. It bounds recovery from a stalled or failed embedding. Keep it above an embedding job's full retry span, about 8 minutes. Otherwise a slow-but-live job is reset while it still runs, which repeats work. Lower it to recover faster; raise it to be more conservative.

- **`ARCHESTRA_KNOWLEDGE_BASE_HYBRID_SEARCH_ENABLED`** - Enable or disable hybrid search (combines vector similarity with full-text search using Reciprocal Rank Fusion).
  - Default: `true`
  - Set to `false` to use vector similarity search only.

- **`ARCHESTRA_KNOWLEDGE_BASE_BM25_K1`** - Deployment default for the BM25 Term Saturation (`k1`), from `0` to `10`.
  - Default: `1.2`
  - Keyword ranking in knowledge search is BM25, computed in plain SQL from statistics tables — no PostgreSQL extension, no extra index, so it runs on managed PostgreSQL such as RDS, Aurora, Neon, and Cloud SQL. This factor is how much repeating a word keeps helping a passage: higher lets repetition keep adding weight, `0` counts a word the same whether it appears once or fifty times. Lucene's default. An organization can override it under **Settings > Knowledge > Search Ranking Configuration**; this value applies where that is left empty.

- **`ARCHESTRA_KNOWLEDGE_BASE_BM25_B`** - Deployment default for the BM25 Length Normalization (`b`), from `0` to `1`.
  - Default: `0.75`
  - How much long passages are held back: `0` means length does not matter, `1` means short, focused passages pull well ahead of long ones that mention the same words. Lucene's default. An organization can override it under **Settings > Knowledge > Search Ranking Configuration**; this value applies where that is left empty.

- **`ARCHESTRA_KNOWLEDGE_BASE_BM25_RECALL_CAP`** - How many candidate chunks BM25 rescores per query.
  - Default: `2000`
  - BM25 ranks, it does not index. The existing full-text index finds the candidates and this caps how many of them get scored. Cost grows roughly in step with the cap. A query matching more chunks than the cap can only reorder what `ts_rank` surfaced first, so raise this if broad queries matter more than latency.

- **`ARCHESTRA_KNOWLEDGE_BASE_BM25_STATS_REFRESH_INTERVAL_SECONDS`** - How often the BM25 corpus statistics are rebuilt.
  - Default: `3600`
  - The first rebuild runs right after startup; until it has finished, keyword matches are ranked with PostgreSQL's built-in `ts_rank`. The refresh reads every chunk, so its cost grows with the corpus. It never blocks ingestion. Statistics that lag the corpus shift scores slightly rather than making them wrong, so a long interval is safe on a large deployment.

- **`ARCHESTRA_KNOWLEDGE_BASE_BM25_STATS_REFRESH_TIMEOUT_MS`** - How long one statistics rebuild may run before PostgreSQL cancels it.
  - Default: `900000` (15 minutes), from `30000` to `21600000`
  - The rebuild reads the whole corpus on a timer, so it needs far longer than a request. Raise it if a rebuild on a very large corpus is cancelled — a rebuild that never finishes leaves keyword search on `ts_rank` for good, since the next attempt gets no further.

- **`ARCHESTRA_KNOWLEDGE_BASE_SEARCH_STATEMENT_TIMEOUT_MILLIS`** - Per-statement timeout for the knowledge search lanes (vector and keyword), in milliseconds.
  - Default: `8000`
  - Tighter than the pool-wide `ARCHESTRA_DATABASE_STATEMENT_TIMEOUT_MILLIS`. A search lane that exceeds it is dropped and the remaining lanes' results are merged. The query fails only when every lane times out. Timed-out lanes are counted in the `rag_search_lane_timeout_total` metric. Set to `0` to inherit the pool-wide timeout.

- **`ARCHESTRA_KNOWLEDGE_BASE_QUOTE_VERIFICATION_ENABLED`** - Verifiable citations. In the built-in chat, the model is asked to back each claim with a short verbatim quote tagged with its source chunk's ref; this checks each quote against the chunk its ref names and logs plus meters (`rag_quote_verification_total`) every miss — a quote found in no returned chunk is a likely fabrication, a quote whose ref names no returned chunk but whose text exists in another one is a mis-citation.
  - Default: `true`
  - Log-only: it never blocks or alters an answer, and only covers the internal chat (external MCP clients answer where Archestra cannot see the text). Set to `false` to disable the feature: the model is no longer asked to quote, and no check runs.

- **`ARCHESTRA_KNOWLEDGE_BASE_CHUNK_SIZE_TOKENS`** - Token budget for one chunk, including its title prefix and metadata suffix.
  - Default: `512`. Clamped to `128`–`2048`.
  - Smaller chunks make a hit more precise but carry less surrounding context; larger chunks do the reverse. Applies at ingest only — existing chunks keep the size they were written at until their connector re-syncs, so changing this mid-corpus leaves a mix until everything has been re-indexed.

- **`ARCHESTRA_KNOWLEDGE_BASE_CHILD_CHUNK_SIZE_TOKENS`** - Token budget for one child chunk under [multi-granularity indexing](/docs/platform-knowledge#multi-granularity-indexing). Each passage produced at `ARCHESTRA_KNOWLEDGE_BASE_CHUNK_SIZE_TOKENS` is split again into children of this size, and only the children are indexed and embedded. A search hit resolves back to its passage, so matching happens at the smaller size while the agent reads the same passage it would have read before.
  - Default: `0`, which disables it. Any other value is clamped to `32`–`2048`.
  - Set it below the chunk size — a child budget that is not smaller leaves each passage undivided, so nothing changes but the bookkeeping. Several children of one passage often match at once; only the best-ranked one is kept, so a passage never appears twice in one result set. Context expansion does not apply to a hit served this way.
  - The cost is index size, not embedding spend: the children cover the same text, so token volume barely moves while the stored vector count grows by roughly the ratio of the two sizes. Contextual retrieval still runs once per passage. Applies at ingest only, so existing chunks keep their shape until their connector re-syncs; both shapes are searched together in the meantime.

- **`ARCHESTRA_KNOWLEDGE_BASE_CONTEXT_EXPANSION_RADIUS`** - How many neighbouring chunks either side of a search hit are stitched back onto it before the result is returned.
  - Default: `1`. Clamped to `0`–`4`; `0` disables it.
  - Ranking is unaffected — this only widens the passage the model reads around a hit it already earned, so a hit landing mid-sentence or mid-table still arrives with its surroundings. Each step of radius adds up to two more chunks per result, so raising it increases the tokens sent to the model roughly proportionally.

- **`ARCHESTRA_KNOWLEDGE_BASE_CONTEXTUAL_RETRIEVAL_ENABLED`** - Default contextual retrieval mode for organizations that have not saved a choice under **Settings > Knowledge**. `true` selects per-document context; `false` disables context.
  - Default: `false`
  - Per-document context costs one model call per changed document, billed against the configured reranking model. Administrators can also choose per-passage context in the UI for higher recall; it batches passages and uses prompt caching where supported. See [Contextual Retrieval](/docs/platform-knowledge#contextual-retrieval).

- **`ARCHESTRA_KNOWLEDGE_BASE_OCR_MAX_PAGES_PER_DOCUMENT`** - Ceiling on how many textless pages of one PDF the [Document OCR](/docs/platform-knowledge#document-ocr) pass transcribes.
  - Default: `100`
  - Each page is one vision-model call billed against the organization's configured OCR model, so this bounds the worst-case cost of a single document. Pages past the cap stay untranscribed and the document is indexed with a partial-extraction warning naming the cap.

Permission sync for connectors using [auto-sync permissions](/docs/platform-knowledge#auto-sync-permissions) runs in its own worker lane, independent of content sync. Its cadence is not an environment variable: each connector's permission sync interval is set in the connector form, and a pass also runs automatically after a content sync ingests new documents or when triggered manually.

- **`ARCHESTRA_KNOWLEDGE_BASE_AUTO_SYNC_PERMISSIONS_ENABLED`** - Beta gate for the whole auto-sync-permissions feature: the connector visibility option, its permission passes, and the Users and Groups tabs.
  - Default: `false`
  - A blank value falls back to the `ARCHESTRA_BETA` master switch. Existing auto-sync connectors go dormant while it is off — no passes run and the Permissions APIs return 403.
- **`ARCHESTRA_KNOWLEDGE_BASE_MFILES_CONNECTOR_ENABLED`** - Beta gate for the [M-Files connector](/docs/platform-knowledge#m-files): the connector type in the create dialog, creating connectors of the type, and the VAF Add On distribution endpoints.
  - Default: `false`
  - A blank value falls back to the `ARCHESTRA_BETA` master switch. Existing M-Files connectors keep syncing while it is off.
- **`ARCHESTRA_KNOWLEDGE_BASE_PERMISSION_SYNC_WORKER_MAX_CONCURRENT`** - Concurrency cap for the runtime-isolated permission-sync worker lane.
  - Default: `1`
  - This lane is separate from the content lane's `ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_MAX_CONCURRENT`, so permission sync never competes with content sync for slots.

#### Perforce Permission Sync (p4 Shim)

Permission sync for the [Perforce connector](/docs/platform-knowledge#perforce-helix-core) runs the `p4` CLI in a small in-cluster pod — the p4 shim. It requires the Kubernetes orchestrator. The shim image ships no Perforce software: the `p4` client is proprietary and is never redistributed in Archestra images. The backend downloads the pinned binary when it provisions the pod, verifies its checksum, and pushes it in. Air-gapped installs point the URL variables at an internal mirror and update the checksums to match.

Each connector gets its own shim, so one connector's Perforce credentials never pass through another's pod and its pod can only reach its own server. The shim is created when a connector starts syncing permissions and removed when it stops — deleted, disabled, or switched to another visibility. It runs one replica the whole time, with equal CPU and memory requests and limits, so Kubernetes places it in the Guaranteed quality-of-service class. Editing a connector's server URL, wire address, admin user or credentials replaces the pod and its access token, so nothing from the previous settings survives.

- **`ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_SHIM_IMAGE`** - Override for the p4 shim image.
  - Default: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/p4-shim:<platform version>`
- **`ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_URL_AMD64`** / **`ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_URL_ARM64`** - Download URL for the `p4` binary, per architecture.
  - Default: the Perforce CDN r25.2 builds (`https://cdist2.perforce.com/perforce/r25.2/bin.linux26x86_64/p4` and `https://cdist2.perforce.com/perforce/r25.2/bin.linux26aarch64/p4`)
- **`ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_SHA256_AMD64`** / **`ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_SHA256_ARM64`** - Expected SHA-256 of each downloaded binary. A download that does not match is rejected.
  - Default: the checksums of the r25.2 CDN builds. Update them together with the URL variables.

The Google Drive connector's [individual auth mode](/docs/platform-knowledge#one-google-account) authorizes through a Google OAuth client that belongs to the deployment. Create a **Web application** client in the Google Cloud Console, enable the Google Drive API, and register `<your Archestra URL>/api/connectors/gdrive/oauth/callback` as an authorized redirect URI — the connector form shows the exact string this deployment sends. The service-account modes, domain-wide delegation included, need neither variable.

- **`ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID`** - Client ID of that OAuth client.
  - Default: Not set (the mode appears in the connector form but is disabled, naming these variables).
- **`ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`** - Client secret of that OAuth client.
  - Default: Not set.
  - The secret is read on every token refresh, so rotating it alone needs no reconnect. Changing the client **ID** invalidates existing authorizations — each affected connector reports that and needs reconnecting.

### Data Retention

> **Enterprise feature:** Contact sales@archestra.ai for licensing information.

Automatic deletion of content-bearing records after a configurable number of days. All windows are **disabled by default** — records are kept indefinitely until an operator opts in. Startup fails when a window is configured without an active enterprise license, so a deployment relying on retention can never run with it silently disabled. When enabled, a sweep runs once every 24 hours as a background task and deletes in small batches.

- **`ARCHESTRA_LLM_LOGS_RETENTION_DAYS`** - Days to retain LLM proxy logs (the `interactions` records behind the LLM Logs page) before automatic deletion.
  - Default: `0` (disabled).
  - Rows that newer records still depend on for request reconstruction are retained until those newer records expire too.
  - A window shorter than 32 days logs a startup warning: monthly cost-limit periods aggregate these records, so deleting inside that horizon can under-count usage against limits. All-time cost statistics reflect retained records only.
- **`ARCHESTRA_MCP_LOGS_RETENTION_DAYS`** - Days to retain MCP gateway tool-call logs before automatic deletion.
  - Default: `0` (disabled).
- **`ARCHESTRA_CHAT_CONVERSATIONS_RETENTION_DAYS`** - Days after a conversation's last message activity before the conversation is automatically deleted, together with its messages, attachments, and conversation files.
  - Default: `0` (disabled).
  - Any new message resets the clock — only genuinely idle conversations expire.
- **`ARCHESTRA_AUDIT_LOG_RETENTION_DAYS`** - Days to retain audit log records (administrative actions — mutations via `/api/*` and auth events) before automatic deletion.
  - Default: `0` (disabled — audit rows are kept indefinitely).

### Maintenance Mode

- **`ARCHESTRA_MAINTENANCE_MODE_MESSAGE`** - Enables maintenance mode and displays a custom message to all users blocking access to the platform.
  - Default: Not set (maintenance mode disabled)
  - When set, all users are shown a full-screen maintenance overlay with the message instead of the normal application interface.

### Site Notification Banner

- **`ARCHESTRA_SITE_NOTIFICATION_MESSAGE`** - Displays an instance-wide banner at the top of the UI, including the login screen.
  - Default: Not set (no banner)
  - Supports markdown. Users can dismiss the banner; a changed message reappears for everyone.
  - Unlike maintenance mode, the platform stays fully functional. Useful for labeling non-production instances or announcing upcoming maintenance.
  - Shown alongside (above) any organization-level site notification configured in Settings → Organization.

### Enterprise Licensing

To learn more about enterprise licensing, see the [pricing model](/docs/platform-pricing-model).
