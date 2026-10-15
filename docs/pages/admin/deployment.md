---
title: Deployment
description: Install Archestra with Docker or Helm and configure production access
order: 1
lastUpdated: 2026-10-15
---

Run the Docker quickstart for local evaluation, or use Helm for a persistent Kubernetes deployment. Before connecting agents, verify database readiness, public URLs, and a model request through your ingress.

## Docker Deployment

### Quickstart Deployment

The quickstart bundles PostgreSQL and a local cluster. Install Docker, then use the command in [Run Archestra](/docs/get-started#run-archestra). Its named volumes preserve database and application data. The Docker socket mount enables the embedded Kubernetes cluster for self-hosted MCP servers.

Open <http://localhost:3000> to confirm the UI loads. Keep the loopback port bindings for a local instance. For production, use Helm and a database with backups.

### Using External PostgreSQL

Set [`ARCHESTRA_DATABASE_URL`](/docs/reference/configuration#ARCHESTRA_DATABASE_URL) to use an external database. Without an external URL, the container starts PostgreSQL internally; preserve `/var/lib/postgresql/data` with a volume. Keep `/app/data` persistent for automatically generated secrets.

## Helm Deployment

You need a Kubernetes cluster, Helm 3 or later, and `kubectl` access. Self-hosted MCP workloads need the chart's orchestration permissions. Network restrictions require a policy-enforcing cluster dataplane; see [Environment network policies](/docs/admin/environments#network-egress-policies).

### Installation

Pin a chart version from [GitHub Releases](https://github.com/archestra-ai/archestra/releases) and review its defaults. The example tracks the current release candidate; choose a release your organization has validated:

```bash
export ARCHESTRA_VERSION="1.4.0-rc.42" # x-release-please-version
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

After Helm completes, run `kubectl --namespace archestra get pods,jobs` and confirm the migration Job completed and application pods are ready.

### Core Configuration

Use `archestra.env` for non-secret environment variables. Use `archestra.envWithValueFrom`, `archestra.envFromSecrets`, or `archestra.envFrom` for Kubernetes Secret references. The full environment-variable list is in [Configuration](/docs/reference/configuration).

The chart generates and preserves authentication and credential-encryption secrets. To supply your own:

```yaml
archestra:
  authSecret:
    existingSecretName: archestra-auth
    existingSecretKey: auth-secret
```

The referenced Secret must also contain `session-secret` and `secrets-encryption-secret`. Preserve these keys across upgrades and restores. Use the [key rotation procedure](/docs/admin/security/credentials#database-storage) when changing encryption keys.

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

### Cost Statistics Index

For large interaction histories, an optional covering index reduces database reads for Costs statistics. It adds index storage and maintenance work to interaction inserts.

After the database migrations finish, run this command once from `/app/backend` in the application container during a database maintenance window:

```bash
node scripts/create-statistics-index.mjs
```

The command uses [`ARCHESTRA_DATABASE_URL`](/docs/reference/configuration#ARCHESTRA_DATABASE_URL). Connect directly to PostgreSQL or through session pooling, using credentials that can create indexes. Transaction pooling is unsupported.

The build runs concurrently with interaction writes and consumes database I/O while it scans. It stops after a five-second lock wait or a thirty-minute statement timeout. Rerunning preserves a valid index and rebuilds an invalid index left by an interrupted build. Successful output reports `created`, `already_valid`, or `rebuilt_invalid`.

### Scaling

`archestra.replicaCount` controls web replicas. `archestra.worker.replicaCount` controls separate workers. Enabling `archestra.horizontalPodAutoscaler.enabled` replaces the web replica setting; the default HPA range is 2–10 pods. Worker replicas remain manual. Increase database connection capacity alongside replicas.

Use `archestra.resources` and `archestra.worker.resources` to size pods. Diagnostics storage shared by concurrent pods requires a compatible `ReadWriteMany` volume; check `archestra.diagnostics` in the selected chart's values.

### Accessing the Platform

Forward both UI and API ports to verify the installation before adding ingress:

```bash
kubectl --namespace archestra port-forward svc/archestra-platform 9000:9000 3000:3000
```

Open <http://localhost:3000> and confirm sign-in works. In another terminal, check database readiness:

```bash
curl --fail-with-body http://localhost:9000/ready
```

A ready instance reports `status: "ok"` and `database: "connected"`. Configure TLS and public URLs before connecting external agents.

### Routing the LLM Proxy Away From the Frontend

Route `/v1` and `/v2` to backend port 9000 and `/` to frontend port 3000. Keep `/api/auth` on the frontend. The chart applies this split for `archestra.ingress.hosts` by default. A complete `archestra.ingress.spec` or an external routing layer must apply it explicitly.

### Keep-Alive Timeouts

Set the ingress or load-balancer response timeout long enough for streamed model responses. Also set [`ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS`](/docs/reference/configuration#ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS) above the load balancer's backend idle-connection timeout if it exceeds the platform default. Send a streaming model request through the public endpoint and check it completes; use the [proxy request example](/docs/llm-proxy#start-using-it) with `"stream": true`.

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

During shutdown, Archestra stops accepting new model requests and gives active requests up to 60 seconds to finish. Requests that outlast this window can still lose their connection. The Helm chart sets `archestra.terminationGracePeriodSeconds` to 120; keep it at least this high so the container can finish shutdown.

For Docker, use `docker stop --time 120` or set Compose's `stop_grace_period: 120s`. A shorter host deadline can kill the container before requests finish.


Rolling back a container image does not reverse database migrations. Restore a compatible database backup when required by the release's rollback procedure.

## Infrastructure as Code

Use the [Terraform provider](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs) to manage agents, catalog entries, and installations from code. Use a [service-account API key](/docs/reference/api#service-accounts) for shared automation.

### Terraform

Configure credentials in the execution environment:

```bash
export ARCHESTRA_BASE_URL="https://api.archestra.example.com"
# Set ARCHESTRA_API_KEY through your shell or CI secret store.
```

Declare the provider and a catalog entry:

```terraform
terraform {
  required_providers {
    archestra = {
      source = "archestra-ai/archestra"
    }
  }
}

provider "archestra" {}

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

Run `terraform init` and `terraform plan`, inspect the changes, then apply. Confirm the entry and installation appear in **MCP Registry**.

### Crossplane

Install Crossplane first, then follow the [Crossplane provider setup](https://github.com/archestra-ai/terraform-provider-archestra/blob/main/crossplane/README.md). Pin its package version and supply an API key through a Kubernetes Secret. Resource coverage differs from Terraform; check the provider's coverage before choosing it.

## Connect Page Settings

Choose which clients, provider keys, and managed instructions the organization offers under **Settings → Connect Page**. See [organization settings](/docs/get-started/connect#organization-settings) for how these affect setup and existing connections.

### Setup Behind an Authentication Proxy

Allow the setup endpoints through a proxy that otherwise requires an interactive login.

Setup reads `/connect.md`, `/llms.txt`, and the setup endpoints under `/api/client-connections` and `/api/connection-setups/script` without a session. A proxy in front of Archestra that requires login for every URL must let these through. It must also allow `/v1/connection-instructions`; this endpoint checks the installation’s read-only credential and current access.

## Upgrade OAuth Clients

Deploy the unified OAuth Clients release to all replicas together, with the older replicas stopped before the updated application starts. Mixed versions and rolling back to the older authorization model are unsupported. Back up the database before the upgrade.

Existing client IDs, secrets, tokens, provider mappings, and gateway assignments carry over. MCP clients retain MCP Gateway and A2A access; LLM clients retain LLM Proxy access. Custom role actions combine without turning read into update or delete; per-client grants keep their scope. See [OAuth client access control](/docs/admin/access-control#oauth-clients).

After the upgrade, open **Settings → OAuth Clients**, check capabilities and permissions, and test one request for each enabled API. Request only the [token scopes](/docs/mcp/authentication/applications#choose-token-scopes) the application needs.
