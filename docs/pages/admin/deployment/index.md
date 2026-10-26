---
title: Deployment
description: Install Archestra on Kubernetes with Helm
order: 1
lastUpdated: 2026-10-22
---

<span id="docker-deployment"></span><span id="quickstart-deployment"></span>

Install Archestra on Kubernetes with Helm. You need a cluster, Helm 3 or later, and `kubectl` access. For a local trial with Docker, use [Run Archestra](/docs/get-started#run-archestra).

<span id="helm-deployment"></span>

<span id="installation"></span>

<span id="core-configuration"></span><span id="database-configuration"></span><span id="using-external-postgresql"></span>

## Install with Helm

1. Choose a release and download its chart defaults:

   ```bash
   export ARCHESTRA_VERSION="1.5.0-rc.10" # x-release-please-version
   helm show values \
     oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts/archestra-platform \
     --version "$ARCHESTRA_VERSION" > values.yaml
   ```

2. Edit `values.yaml` for your [PostgreSQL database](/docs/admin/deployment/database), [public URLs and ingress](/docs/admin/deployment/networking), and secrets. Use `archestra.env` for non-secret values and `archestra.envWithValueFrom` or `archestra.envFromSecrets` for Secret references.
3. Install the selected version:

   ```bash
   helm upgrade archestra-platform \
     oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts/archestra-platform \
     --version "$ARCHESTRA_VERSION" \
     --install --namespace archestra --create-namespace \
     --values values.yaml --wait
   ```

The chart generates and preserves authentication and credential-encryption keys. Back them up with your database. To supply existing keys, set `archestra.authSecret.existingSecretName` and `existingSecretKey`; the same Secret must contain `session-secret` and `secrets-encryption-secret`.

<span id="accessing-the-platform"></span>

## Verify the Installation

For a local check before configuring ingress:

```bash
kubectl --namespace archestra port-forward svc/archestra-platform 9000:9000 3000:3000
```

Open <http://localhost:3000>, sign in, and [connect a client](/docs/get-started/connect). Send a message and find its request in **Logs → LLM Proxy**.

<span id="code-sandbox"></span>

<span id="connect-page-settings"></span>

<span id="cost-statistics-index"></span>

<span id="crossplane"></span>

<span id="enable-fast-logs-user-lists"></span>

<span id="infrastructure-as-code"></span>

<span id="keep-alive-timeouts"></span>

<span id="mcp-apps-sandbox"></span>

<span id="mcp-gateway-oauth-public-origin"></span>

<span id="release-channels-and-upgrades"></span>

<span id="routing-the-llm-proxy-away-from-the-frontend"></span>

<span id="ssrf-protection-for-mcp-server-pods"></span>

<span id="terraform"></span>

<span id="upgrade-oauth-clients"></span>

Before exposing the instance publicly, configure [TLS and public URLs](/docs/admin/deployment/networking). [Agent Runtime](/docs/agents/runtime/setup) have additional cluster requirements.

<span id="scaling"></span>

## Scale Web and Worker Pods

Set `archestra.replicaCount` for web pods and `archestra.worker.replicaCount` for workers. The web HPA, enabled with `archestra.horizontalPodAutoscaler.enabled`, overrides the web replica count. [Increase database connection capacity](/docs/admin/deployment/database#connection-capacity) alongside replicas.

Set `archestra.resources` and `archestra.worker.resources` for pod sizing. To spread each workload across zones:

```yaml
archestra:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
```

For declarative resource management after installation, use the [Terraform provider](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs) or its [Crossplane package](https://github.com/archestra-ai/terraform-provider-archestra), with a dedicated [service account](/docs/reference/api#service-accounts).
