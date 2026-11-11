---
title: Production
description: Prepare database recovery, public access, cluster security, and capacity before serving traffic
order: 2
lastUpdated: 2026-11-09
---

Before sending production traffic through Archestra, make sure you can restore its database and keys, reach its public endpoints, and run its workloads safely.

## Releases and Backups

Test an exact release in staging before applying it to production.

- Read the release's migration and compatibility notes before a [Helm upgrade](/docs/admin/deployment/helm#upgrade).
- Use [PostgreSQL](/docs/admin/deployment/database) with backups and availability suited to your recovery requirements. The chart's bundled database has one replica.
- [Connect it](/docs/admin/deployment/database#connect-a-database) over a private network, with your cloud's identity instead of a password where your cloud supports it.
- Back up PostgreSQL together with authentication, credential-encryption, and [content-encryption keys](/docs/admin/content-encryption). Test restoring them together; losing an encryption key can make saved data unreadable.

## Public Access

Configure [Networking](/docs/admin/deployment/networking#public-urls-and-ingress) before exposing the instance.

- Use HTTPS and configure the public UI and API URLs to match your ingress.
- Test a streaming model request and an MCP tool call through the public endpoint. Set proxy timeouts for long responses.
- For MCP Apps that need persistent browser storage, configure a [sandbox domain](/docs/admin/deployment/networking#mcp-apps-sandbox).

## Cluster Security

Archestra runs code other people wrote: MCP servers, agent runs, and sandboxed commands. Keep that code away from the platform's keys, and keep everything except the ingress private.

- **Workload namespace:** set `archestra.orchestrator.kubernetes.namespace` to a namespace of its own. MCP servers, Agent Runtime sessions and warm pools, and the [code sandbox](/docs/admin/deployment/networking#code-sandbox-requirements) engines run there, unless an [environment](/docs/admin/environments) names another namespace. Kubernetes lets a pod use only the Secrets, ServiceAccounts, and volume claims of its own namespace, so this code cannot reach the platform's keys or act as its ServiceAccount.
  - Create the namespace before you install: the chart does not create it. Leave its Pod Security Admission level at `privileged` while the code sandbox is on, because its engines run privileged.
  - The chart creates Roles, RoleBindings, ServiceAccounts, and the network policy probe there. The identity that runs `helm upgrade` needs those rights in that namespace, plus `escalate` on each chart Role that grants a permission it does not hold itself, such as `pods/log` in the read-only Role for Kubernetes MCP servers. With the SRE agent on, the chart also adds a copy of that Role to the release namespace.
  - When you change it on a running install, the platform recreates MCP servers, warm pools, and sandbox engines in the new namespace at startup, but leaves the old copies running. Delete them from the old namespace by hand. Until you do, warm-pool volumes count twice. Runs already in progress finish where they started.
- **Agent Runtime:** set [`ARCHESTRA_AGENT_RUNTIME_RUNTIME_CLASS_NAME`](/docs/admin/deployment/configuration#ARCHESTRA_AGENT_RUNTIME_RUNTIME_CLASS_NAME) to a sandboxing RuntimeClass such as gVisor, so a run does not share the node's kernel. [Sandboxed Runtime](/docs/agents/runtime/setup#sandboxed-runtime) covers each cloud. Keep [`ARCHESTRA_AGENT_RUNTIME_ALLOW_PRIVILEGED`](/docs/admin/deployment/configuration#ARCHESTRA_AGENT_RUNTIME_ALLOW_PRIVILEGED) off unless runs need Docker: privileged runs ignore the RuntimeClass. Put runtime pods on their own tainted node pool with [`ARCHESTRA_AGENT_RUNTIME_NODE_SELECTOR`](/docs/admin/deployment/configuration#ARCHESTRA_AGENT_RUNTIME_NODE_SELECTOR), which adds the matching toleration. See [Privileged Containers](/docs/agents/runtime/setup#privileged-containers).
- **Secrets outside the chart:** keep the platform keys in your secret manager and sync them into a Kubernetes Secret, for example with External Secrets or the Secrets Store CSI driver. Point `archestra.authSecret.existingSecretName` and `archestra.envFromSecrets` at it. Argo CD and other tools that render with `helm template` [need `existingSecretName`](/docs/admin/deployment/helm#install). To keep saved credentials out of PostgreSQL, use [Vault](/docs/admin/deployment/secret-storage#hashicorp-vault). To replace a key, follow [Secret Rotation](/docs/admin/deployment/secret-rotation).
- **Cloud access:** give pods cloud permissions through workload identity, such as GKE Workload Identity, EKS IRSA, or AKS Workload Identity, instead of static keys. Grant only the roles Archestra uses. [Connect a Database](/docs/admin/deployment/database#connect-a-database) shows it for each cloud's PostgreSQL.
- **Private by default:** expose only the ingress. Keep the cluster's control plane and the [database](/docs/admin/deployment/database#connect-a-database) on private networks. Set [`ARCHESTRA_METRICS_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_METRICS_SECRET) and keep the metrics port, 9050, off the ingress. Put SSO, an identity-aware proxy, or a VPN in front of non-production instances. Microsoft Teams, Outlook email, and Slack or Jira webhooks also need a few [public webhook endpoints](/docs/admin/deployment/networking#public-webhook-endpoints).
- **Egress:** verify that your network dataplane [enforces workload egress policies](/docs/admin/deployment/networking#enforce-workload-egress). Policy objects alone do not isolate workloads.
- **Release images:** a released chart pins every image to its digest, and every release image carries a signed build provenance attestation in its registry. [Verify Archestra Images](#verify-archestra-images) before you deploy, or let the cluster admit no other Archestra image.
- **Audit trail:** export Archestra's [audit log](/docs/admin/observability/audit-logs) over OTLP with [`ARCHESTRA_AUDIT_LOG_OTEL_ENABLED`](/docs/admin/deployment/configuration#ARCHESTRA_AUDIT_LOG_OTEL_ENABLED), and send your cluster's Kubernetes audit log to the same SIEM.
- **Deploy access:** with the default values, the chart creates nothing outside its namespaces. The CI identity that runs `helm upgrade` needs write access only to the release namespace, the MCP server namespace, and any environment namespaces you list. Do not give people cluster-admin for day-to-day work.

### Verify Archestra Images

Make your cluster refuse any Archestra image that Archestra's release workflow did not build. Every release image carries a build provenance attestation, signed with that workflow's GitHub identity and stored next to the image in its registry, where `gh`, cosign, and admission controllers read it.

A verifier checks three things:

- **Images:** `docker.io/archestra/platform`, and `ghcr.io/archestra-ai/` `mcp-server-base`, `p4-shim`, `sandbox-base`, and `agent-*`.
- **Issuer:** `https://token.actions.githubusercontent.com`.
- **Identity:** `https://github.com/archestra-ai/archestra/.github/workflows/release-please.yml@refs/heads/release/<major>.<minor>` for stable releases, `@refs/heads/main` for release candidates.

Check the platform image you run:

```bash
IMAGE=$(kubectl -n archestra get deployment archestra-platform \
  -o jsonpath='{.spec.template.spec.containers[0].image}')
gh attestation verify "oci://docker.io/archestra/platform@${IMAGE#*@}" \
  --repo archestra-ai/archestra --bundle-from-oci
cosign verify-attestation --new-bundle-format --type slsaprovenance1 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/archestra-ai/archestra/\.github/workflows/release-please\.yml@refs/heads/(main|release/[0-9]+\.[0-9]+)$' \
  "docker.io/archestra/platform@${IMAGE#*@}"
```

Both commands exit non-zero for an image Archestra did not release. To enforce it at admission:

- **Kyverno:** this [`SigstoreBundle` policy](https://kyverno.io/docs/policy-types/cluster-policy/verify-images/sigstore/) rejects a pod whose Archestra image fails the check. Pods with other images pass through.

  ```yaml
  apiVersion: kyverno.io/v1
  kind: ClusterPolicy
  metadata:
    name: verify-archestra-images
  spec:
    webhookTimeoutSeconds: 30
    rules:
      - name: archestra-build-provenance
        match:
          any:
            - resources:
                kinds: [Pod]
        verifyImages:
          - type: SigstoreBundle
            failureAction: Enforce
            imageReferences:
              - "docker.io/archestra/platform*"
              - "ghcr.io/archestra-ai/mcp-server-base*"
              - "ghcr.io/archestra-ai/p4-shim*"
              - "ghcr.io/archestra-ai/sandbox-base*"
              - "ghcr.io/archestra-ai/agent-*"
            attestations:
              - type: https://slsa.dev/provenance/v1
                attestors:
                  - entries:
                      - keyless:
                          issuer: https://token.actions.githubusercontent.com
                          subjectRegExp: '^https://github\.com/archestra-ai/archestra/\.github/workflows/release-please\.yml@refs/heads/(main|release/[0-9]+\.[0-9]+)$'
                          rekor:
                            url: https://rekor.sigstore.dev
  ```

- **Sigstore policy-controller:** set `signatureFormat: bundle` in a `ClusterImagePolicy` with the issuer and identity above. See [Sigstore bundle format](https://docs.sigstore.dev/policy-controller/overview/).
- **GKE Binary Authorization:** its [Sigstore signature check](https://docs.cloud.google.com/binary-authorization/docs/cv-sigstore-check) verifies only public-key signatures in Artifact Registry, so it cannot check these attestations. On GKE, use Kyverno or policy-controller.

What to know:

- To admit release candidates nowhere, drop `main|` from the identity pattern.
- A registry mirror must copy the attestations with the image: `oras cp -r <image>@<digest> <mirror>/<image>` does. Point the policy's image references at the mirror.
- An older release may have its attestations on GitHub only. If `--bundle-from-oci` finds none, drop the flag to check with GitHub instead.

## Cluster Capacity

Size the web pods, workers, and database for your organization with [Sizing and High Availability](/docs/admin/deployment/scaling), which also sets them up to survive a lost node or zone. Validate the size against realistic requests, payloads, and background work in staging before serving production traffic.

- Reserve separate capacity for the [code sandbox](/docs/admin/deployment/networking#code-sandbox-requirements).

### MCP Servers

Budget extra capacity for self-hosted MCP server pods, beyond the web and worker pods.

- **Resources:** set resource defaults under `archestra.orchestrator.mcpServerResources`. For per-server changes, see [Self-Hosted Servers](/docs/mcp/servers/self-hosted#change-how-it-runs).
- **Placement:** MCP server pods inherit the platform pod's node selector and tolerations; `archestra.nodeSelector` and `archestra.tolerations` set shared placement defaults. There is no separate MCP-only node-pool setting in Helm, and inherited selectors still apply to custom server YAML.
- **Scaling:** use node autoscaling to add capacity on compatible nodes as servers start. The web HPA does not scale MCP server pods; optional [idle hibernation](/docs/mcp/servers/self-hosted#idle-hibernation) releases unused capacity.

### Agent Runtime

Size runtime capacity separately from the web and worker pods. Follow [Runtime Setup](/docs/agents/runtime/setup) for the Agent Sandbox controller, storage, and node placement.

Use [node autoscaling](https://kubernetes.io/docs/concepts/cluster-administration/node-autoscaling/) on the runtime node pool so the cluster can add capacity as runs create pods. Account for each run's configured CPU, memory, and persistent volume, plus [warm-pool spares](/docs/agents/runtime/setup#warm-pools). The web HPA does not scale runtime pods or cluster nodes.

## Infrastructure as Code

Manage Archestra resources such as agents, MCP server installations, and environments declaratively after installing the platform.

- **Terraform:** use the [Terraform provider](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs).
- **Crossplane:** use the [Crossplane provider](https://marketplace.upbound.io/providers/archestra/provider-archestra/v3.0.3) to declare Archestra resources as Kubernetes objects.

Use a dedicated [service account](/docs/reference/api#service-accounts) for automation. The [provider repository](https://github.com/archestra-ai/terraform-provider-archestra) contains source code and examples for both providers.
