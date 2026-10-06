---
title: Deployment
description: Install Archestra with Docker or Helm and configure production access
order: 1
lastUpdated: 2026-10-05
---

Use Docker to try Archestra locally. Use Helm to run it in Kubernetes with a persistent database, workers, and MCP server workloads. The UI listens on port 3000; the backend listens on port 9000.

## Docker Deployment

### Quickstart Deployment

Install Docker, then use the command in [Run Archestra](/docs/get-started#run-archestra). Its named volumes preserve database and application data. The Docker socket mount enables the embedded Kubernetes cluster for self-hosted MCP servers.

Open <http://localhost:3000> to confirm the UI loads. Keep the loopback port bindings for a local instance. For production, use Helm and a database with backups.

### Using External PostgreSQL

Set [`ARCHESTRA_DATABASE_URL`](/docs/reference/configuration#ARCHESTRA_DATABASE_URL) to use an external database. Without an external URL, the container starts PostgreSQL internally; preserve `/var/lib/postgresql/data` with a volume. Keep `/app/data` persistent for automatically generated secrets.

## Helm Deployment

You need a Kubernetes cluster, Helm 3 or later, and `kubectl` access. Self-hosted MCP workloads need the chart's orchestration permissions. Network restrictions require a policy-enforcing cluster dataplane; see [Environment network policies](/docs/admin/environments#network-egress-policies).

### Installation

Pin the chart version and review its defaults:

```bash
export ARCHESTRA_VERSION="1.4.0-rc.31" # x-release-please-version
helm show values \
  oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts/archestra-platform \
  --version "$ARCHESTRA_VERSION" > values.yaml
```

Edit `values.yaml` for your database, secrets, and ingress, then install:

```bash
helm upgrade archestra-platform \
  oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts/archestra-platform \
  --version "$ARCHESTRA_VERSION" \
  --install --namespace archestra --create-namespace \
  --values values.yaml --wait
```

### Core Configuration

Use `archestra.env` for non-secret environment variables. Use `archestra.envWithValueFrom`, `archestra.envFromSecrets`, or `archestra.envFrom` for Kubernetes Secret references. The full environment-variable list is in [Configuration](/docs/reference/configuration).

The chart generates and preserves authentication and credential-encryption secrets. To supply your own:

```yaml
archestra:
  authSecret:
    existingSecretName: archestra-auth
    existingSecretKey: auth-secret
```

The referenced Secret must also contain `session-secret` and `secrets-encryption-secret`. Preserve these keys across upgrades and restores. Use the [key rotation procedure](/docs/admin/security/secrets-management#database-storage) when changing encryption keys.

### Database Configuration

Use an external PostgreSQL database when availability or managed backups matter. The bundled database runs one replica. Store the complete external URL in a Kubernetes Secret rather than Helm values. With a Secret named `archestra-database` containing a `url` key:

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

Provide the same database URL to the migration Job and application. The chart runs migrations before rolling out an upgrade. Keep `archestra.migrationJob.enabled` enabled unless your pipeline applies migrations separately.

For Knowledge Base vector storage, PostgreSQL must have the pgvector extension available and the migration user must be able to create the extension, or an administrator must install it first.

Set `archestra.database.connectionBudget` to size query pools across peak web and worker pods, including rollout overlap. Leave room in PostgreSQL for other clients and reserved connections. Each peak pod needs at least 13 budgeted connections; the chart rejects smaller budgets. A fixed `archestra.database.poolMax` or [`ARCHESTRA_DATABASE_POOL_MAX`](/docs/reference/configuration#ARCHESTRA_DATABASE_POOL_MAX) overrides budget sizing. Complete one rollout before starting another.

### Scaling

`archestra.replicaCount` controls web replicas. `archestra.worker.replicaCount` controls separate workers. Enabling `archestra.horizontalPodAutoscaler.enabled` replaces the web replica setting; the default HPA range is 2–10 pods. Worker replicas remain manual. Increase database connection capacity alongside replicas.

Use `archestra.resources` and `archestra.worker.resources` to size pods. Diagnostics storage shared by concurrent pods requires a compatible `ReadWriteMany` volume; check `archestra.diagnostics` in the selected chart's values.

### Accessing the Platform

For a local verification before configuring ingress:

```bash
kubectl --namespace archestra port-forward svc/archestra-platform 9000:9000 3000:3000
```

Open <http://localhost:3000>. Confirm you can sign in and that the backend is reachable on port 9000. For an external deployment, configure TLS and the public URLs before connecting agents.

### Routing the LLM Proxy Away From the Frontend

Route `/v1` and `/v2` to backend port 9000 and `/` to frontend port 3000. Keep `/api/auth` on the frontend. The chart applies this split for `archestra.ingress.hosts` by default. A complete `archestra.ingress.spec` or an external routing layer must apply it explicitly.

### Keep-Alive Timeouts

Set the ingress or load-balancer response timeout long enough for streamed model responses. Also set [`ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS`](/docs/reference/configuration#ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS) above the load balancer's backend idle-connection timeout if it exceeds the platform default. Test a streaming request through the public endpoint.

### MCP Gateway OAuth Public Origin

List every public gateway host in [`ARCHESTRA_API_BASE_URL`](/docs/reference/configuration#ARCHESTRA_API_BASE_URL) or [`ARCHESTRA_FRONTEND_URL`](/docs/reference/configuration#ARCHESTRA_FRONTEND_URL), using its public `https://` scheme. API base URLs accept a comma-separated list. This keeps OAuth metadata and connection documents on HTTPS even when TLS terminates before Archestra.

An unconfigured host falls back to the request scheme. A proxy that drops `X-Forwarded-Proto` can therefore advertise HTTP and break OAuth discovery. [`ARCHESTRA_TRUST_PROXY`](/docs/reference/configuration#ARCHESTRA_TRUST_PROXY) does not change this public-origin rule.

### SSRF Protection for MCP Server Pods

Self-hosted MCP servers inherit [environment egress policies](/docs/admin/environments#network-egress-policies). Public internet mode blocks private, metadata, and reserved destinations unless explicitly allowed. The cluster's network dataplane must enforce those policies; creating policy objects alone does not enforce isolation.

## MCP Apps Sandbox

Local instances isolate MCP Apps using `localhost` and `127.0.0.1`. Production instances without a sandbox domain use an opaque iframe origin, which cannot use persistent browser storage or APIs restricted to a specific origin.

For apps needing those capabilities:

1. Choose a sandbox domain such as `mcp.example.com`.
2. Create wildcard DNS and TLS for `*.mcp.example.com`.
3. Route that wildcard host to backend port 9000.
4. Set [`ARCHESTRA_MCP_SANDBOX_DOMAIN=mcp.example.com`](/docs/reference/configuration#ARCHESTRA_MCP_SANDBOX_DOMAIN).
5. Open an app and confirm it renders through its sandbox host.

Allowed embedding origins follow [`ARCHESTRA_FRONTEND_URL`](/docs/reference/configuration#ARCHESTRA_FRONTEND_URL) and [`ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS`](/docs/reference/configuration#ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS).

## Code Sandbox

Archestra's managed Dagger engines need Linux nodes that permit privileged root pods with all Linux capabilities, plus dynamically provisioned `ReadWriteOnce` storage. Engine pods are separate from agent runtime containers.

If your cluster does not admit these pods, set [`ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST`](/docs/reference/configuration#ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST) to an external `tcp://` or `kube-pod://` engine, or disable the sandbox with [`ARCHESTRA_CODE_RUNTIME_ENABLED=false`](/docs/reference/configuration#ARCHESTRA_CODE_RUNTIME_ENABLED) or Helm's `archestra.codeRuntime.enabled: false`.

## Release Channels And Upgrades

Pin an exact chart version or image tag from [GitHub Releases](https://github.com/archestra-ai/archestra/releases). Tags ending in `-rc.N` are release candidates. Avoid relying on `latest` for production upgrades.

1. Back up PostgreSQL and preserve encryption keys.
2. Read release notes for migration requirements.
3. Test the selected version in staging.
4. Apply the Helm upgrade above and check rollout and migration Job status.

Rolling back a container image does not reverse database migrations. Restore a compatible database backup when required by the release's rollback procedure.

## Infrastructure as Code

Manage Archestra resources from Terraform or Crossplane. Both use the same API key — mint one in the API Keys section in Personal Settings (click your name in the sidebar) (see [API Reference](/docs/reference/api#authentication)).

### Terraform

1. Configure the provider. Read credentials from the environment (`export ARCHESTRA_API_KEY=...` and `export ARCHESTRA_BASE_URL=...`) or pass them inline.

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

2. Define a resource. Register an MCP server in the catalog, then install it.

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

3. Apply.

```bash
terraform init
terraform apply
```

Full resource reference: [Terraform provider docs](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs).

### Crossplane

Install Crossplane v1 or v2 before adding the provider.

1. Install the provider. Pin the latest tag from [GitHub Releases](https://github.com/archestra-ai/terraform-provider-archestra/releases).

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-archestra
spec:
  package: xpkg.upbound.io/archestra/provider-archestra:v1.1.4
```

2. Configure credentials.

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

3. Create a resource. Mirror of the Terraform example above.

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

<span id="connection-page-settings"></span>

## Connect Page Settings

Admins configure the page under **Settings → Connect Page**, or with **Connection settings** on the Connect page:

| Setting | Effect |
| --- | --- |
| Available clients | The clients the page offers. **Any Client** is always shown. |
| LLM Proxy, Skills, and Plugins on Connect | Turning one off removes it from new setups. Existing setups keep working. |
| Default MCP Gateway, Default client | Pre-selected for everyone. Users can still switch. |
| Default provider keys | The provider key a setup's virtual key maps to, per provider. |
| Suggest runtime handoff | Lets connected agents suggest moving work to [Agent Runtime](/docs/agents/runtime). On by default. Users re-run setup to pick up a change. |

Setup reads `/connect.md`, `/llms.txt`, and the setup endpoints under `/api/client-connections` and `/api/connection-setups/script` without a session. A proxy in front of Archestra that requires login for every URL must let these through.
