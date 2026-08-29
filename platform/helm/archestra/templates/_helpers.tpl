{{/*
Expand the name of the chart.
*/}}
{{- define "archestra-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "archestra-platform.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Broad Role used by the platform to manage MCP runtime resources. */}}
{{- define "archestra-platform.mcpManagerRoleName" -}}
{{- printf "%s-mcp-manager" (include "archestra-platform.fullname" .) }}
{{- end }}

{{/* Narrow Helm-managed Role that owns runtime-created MCP resources. */}}
{{- define "archestra-platform.mcpRuntimeOwnerRoleName" -}}
{{- printf "%s-mcp-runtime-owner" (include "archestra-platform.fullname" .) }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "archestra-platform.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "archestra-platform.labels" -}}
helm.sh/chart: {{ include "archestra-platform.chart" . }}
{{ include "archestra-platform.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: archestra
{{- end }}

{{/*
Selector labels
*/}}
{{- define "archestra-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "archestra-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Maintenance mode can serve the frontend overlay and public config without
database access. The chart can only detect this when the env var is set
directly through archestra.env.
*/}}
{{- define "archestra-platform.maintenanceModeEnabled" -}}
{{- if and (hasKey .Values.archestra.env "ARCHESTRA_MAINTENANCE_MODE_MESSAGE") (ne (toString (get .Values.archestra.env "ARCHESTRA_MAINTENANCE_MODE_MESSAGE")) "") -}}
true
{{- else -}}
false
{{- end -}}
{{- end }}

{{/*
Environment variables for the Archestra Platform container
*/}}
{{- define "archestra-platform.databaseEnv" -}}
{{- $databaseSecretName := .migrationDatabaseSecretNameOverride | default (include "archestra-platform.authSecretName" .) -}}
{{- if eq (toString .Values.postgresql.external_database_url) "from_vault" }}
{{/* Database URL provided by vault-secrets init container — no env var generated */}}
{{- else if .Values.postgresql.external_database_url }}
- name: ARCHESTRA_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $databaseSecretName }}
      key: database-url
{{- else if .Values.postgresql.enabled }}
{{/*
For the bundled PostgreSQL, we use Kubernetes env variable expansion to inject the password
from the Bitnami PostgreSQL secret into the DATABASE_URL. This keeps the password out of the manifest.
The Bitnami chart auto-generates a strong password and persists it across helm upgrades.
*/}}
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "archestra-platform.fullname" . }}-postgresql
      key: password
- name: ARCHESTRA_DATABASE_URL
  value: postgresql://{{ .Values.postgresql.auth.username }}:$(PGPASSWORD)@{{ include "archestra-platform.fullname" . }}-postgresql:5432/{{ .Values.postgresql.auth.database }}
{{- end }}
{{- end }}

{{- define "archestra-platform.env" -}}
{{/*
List of sensitive environment variables that should be stored in the Secret
and referenced via secretKeyRef instead of being exposed as plaintext in Pod specs.
This must match the list in secret.yaml.
Additionally, any env var matching ARCHESTRA_CHAT_*_API_KEY is treated as sensitive.
*/}}
{{- $sensitiveEnvVars := list
  "ARCHESTRA_AUTH_SECRET"
  "ARCHESTRA_AUTH_SESSION_SECRET"
  "ARCHESTRA_SECRETS_ENCRYPTION_SECRET"
  "ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS"
  "ARCHESTRA_CONTENT_ENCRYPTION_SECRET"
  "ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS"
  "ARCHESTRA_AUTH_ADMIN_PASSWORD"
  "ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD"
  "ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER"
  "ARCHESTRA_METRICS_SECRET"
  "ARCHESTRA_HASHICORP_VAULT_TOKEN"
}}
{{- $podNameProvided := hasKey .Values.archestra.env "POD_NAME" }}
{{- $podNamespaceProvided := hasKey .Values.archestra.env "POD_NAMESPACE" }}
{{- range .Values.archestra.envWithValueFrom }}
  {{- if eq .name "POD_NAME" }}{{- $podNameProvided = true }}{{- end }}
  {{- if eq .name "POD_NAMESPACE" }}{{- $podNamespaceProvided = true }}{{- end }}
{{- end }}
{{- if not $podNameProvided }}
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
{{- end }}
{{- if not $podNamespaceProvided }}
- name: POD_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
{{- end }}
{{- if not (hasKey .Values.archestra.env "ARCHESTRA_DATABASE_RUN_MIGRATIONS_ON_STARTUP") }}
- name: ARCHESTRA_DATABASE_RUN_MIGRATIONS_ON_STARTUP
  value: {{ .Values.archestra.migrationJob.enabled | quote }}
{{- end }}
{{- include "archestra-platform.databaseEnv" . }}
{{/*
When both external_database_url is null and postgresql.enabled is false,
ARCHESTRA_DATABASE_URL is not set here. Use archestra.envFromSecrets to inject it from a pre-existing K8s secret.
*/}}
{{/*
Assigns value from autogenerated auth-secret to ARCHESTRA_AUTH_SECRET by default.
If ARCHESTRA_AUTH_SECRET env variable is explicitly set, it will override the autogenerated default.
*/}}
{{- if not (hasKey .Values.archestra.env "ARCHESTRA_AUTH_SECRET") }}
- name: ARCHESTRA_AUTH_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "archestra-platform.authSecretName" . }}
      key: {{ include "archestra-platform.authSecretKey" . }}
{{- end }}
{{/*
Inject the session-signing and secret-encryption secrets from the auth Secret
(Helm-managed or authSecret.existingSecretName) under the fixed session-secret
and secrets-encryption-secret keys — an external Secret must provide both keys.
An explicit archestra.env value overrides the injection.
*/}}
{{- $authSecretName := include "archestra-platform.authSecretName" . }}
{{- if not (hasKey .Values.archestra.env "ARCHESTRA_AUTH_SESSION_SECRET") }}
- name: ARCHESTRA_AUTH_SESSION_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $authSecretName }}
      key: session-secret
      # optional so pods still start when the key is absent (the pre-upgrade
      # migration Job runs before the Secret is updated; config.ts then falls
      # back to ARCHESTRA_AUTH_SECRET).
      optional: true
{{- end }}
{{- if not (hasKey .Values.archestra.env "ARCHESTRA_SECRETS_ENCRYPTION_SECRET") }}
- name: ARCHESTRA_SECRETS_ENCRYPTION_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $authSecretName }}
      key: secrets-encryption-secret
      optional: true
{{- end }}
{{- if not (hasKey .Values.archestra.env "ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE") }}
- name: ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE
  value: {{ default .Release.Namespace .Values.archestra.orchestrator.kubernetes.namespace | quote }}
{{- end }}
{{/* The release name, told to the backend rather than left for it to infer.
     Cluster objects the backend creates for ITSELF (the MCP image pre-pull
     DaemonSet) are named after it, so two releases sharing a namespace never
     fight over one object — and a backend that inferred the name from a pod
     read could infer a different one after a blip and strand a second,
     permanently orphaned object in the cluster. */}}
{{- if not (hasKey .Values.archestra.env "ARCHESTRA_ORCHESTRATOR_HELM_RELEASE_NAME") }}
- name: ARCHESTRA_ORCHESTRATOR_HELM_RELEASE_NAME
  value: {{ .Release.Name | quote }}
{{- end }}
{{- if and .Values.archestra.orchestrator.kubernetes.rbac.create (not (hasKey .Values.archestra.env "ARCHESTRA_ORCHESTRATOR_MCP_RUNTIME_OWNER_ROLE")) }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_RUNTIME_OWNER_ROLE
  value: {{ include "archestra-platform.mcpRuntimeOwnerRoleName" . | quote }}
{{- end }}
{{- if .Values.archestra.orchestrator.baseImage }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE
  value: {{ .Values.archestra.orchestrator.baseImage | quote }}
{{- end }}
{{- if .Values.archestra.knowledgeBase.perforceShim.image }}
- name: ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_SHIM_IMAGE
  value: {{ .Values.archestra.knowledgeBase.perforceShim.image | quote }}
{{- end }}
{{- with .Values.archestra.orchestrator.mcpServerResources }}
{{- if .requests.cpu }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_SERVER_CPU_REQUEST
  value: {{ .requests.cpu | quote }}
{{- end }}
{{- if .requests.memory }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_SERVER_MEMORY_REQUEST
  value: {{ .requests.memory | quote }}
{{- end }}
{{- if .requests.ephemeralStorage }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_SERVER_EPHEMERAL_STORAGE_REQUEST
  value: {{ .requests.ephemeralStorage | quote }}
{{- end }}
{{- if .limits.memory }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_SERVER_MEMORY_LIMIT
  value: {{ .limits.memory | quote }}
{{- end }}
{{- if .limits.ephemeralStorage }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_SERVER_EPHEMERAL_STORAGE_LIMIT
  value: {{ .limits.ephemeralStorage | quote }}
{{- end }}
{{- end }}
{{/* "0" is a meaningful value (disables the reaper), so compare against the
     empty string instead of relying on truthiness. */}}
{{- if ne (toString .Values.archestra.orchestrator.failedPodReapIntervalSeconds) "" }}
- name: ARCHESTRA_ORCHESTRATOR_FAILED_POD_REAP_INTERVAL_SECONDS
  value: {{ .Values.archestra.orchestrator.failedPodReapIntervalSeconds | quote }}
{{- end }}
{{/* "false" is a meaningful value — beta feature explicitly off, winning over
     the ARCHESTRA_BETA master switch — so compare against the empty string
     instead of relying on truthiness. */}}
{{- if ne (toString .Values.archestra.orchestrator.mcpIdleHibernationEnabled) "" }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_ENABLED
  value: {{ .Values.archestra.orchestrator.mcpIdleHibernationEnabled | quote }}
{{- end }}
{{/* "0" is a meaningful value — the operator's kill switch — so compare
     against the empty string instead of relying on truthiness. */}}
{{- if ne (toString .Values.archestra.orchestrator.mcpIdleHibernationSeconds) "" }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_SECONDS
  value: {{ .Values.archestra.orchestrator.mcpIdleHibernationSeconds | quote }}
{{- end }}
{{- with .Values.archestra.orchestrator.mcpImagePrepull }}
{{/* "false" is a meaningful value — the operator's kill switch for pre-pulling
     alone, leaving hibernation on — so compare against the empty string instead
     of relying on truthiness. */}}
{{- if ne (toString .enabled) "" }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_ENABLED
  value: {{ .enabled | quote }}
{{- end }}
{{- if .priorityClassName }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_PRIORITY_CLASS_NAME
  value: {{ .priorityClassName | quote }}
{{- end }}
{{/* This binary is copied into arbitrary MCP images and must be static: the
     generic init-container busybox can use a libc the target image lacks. */}}
{{- $prepullBootstrapImage := .bootstrapImage | default "docker.io/library/busybox:1.36-musl" }}
{{- if $prepullBootstrapImage }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_BOOTSTRAP_IMAGE
  value: {{ $prepullBootstrapImage | quote }}
{{- end }}
{{- if .bootstrapImagePullSecrets }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_BOOTSTRAP_IMAGE_PULL_SECRETS
  value: {{ join "," .bootstrapImagePullSecrets | quote }}
{{- end }}
{{- with .resources }}
{{- if .requests.cpu }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_CPU_REQUEST
  value: {{ .requests.cpu | quote }}
{{- end }}
{{- if .requests.memory }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_MEMORY_REQUEST
  value: {{ .requests.memory | quote }}
{{- end }}
{{- if .limits.memory }}
- name: ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_MEMORY_LIMIT
  value: {{ .limits.memory | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- if and .Values.archestra.orchestrator.kubernetes.kubeconfig.enabled .Values.archestra.orchestrator.kubernetes.kubeconfig.secretName }}
- name: ARCHESTRA_ORCHESTRATOR_KUBECONFIG
  value: {{ printf "%s/config" .Values.archestra.orchestrator.kubernetes.kubeconfig.mountPath | quote }}
{{- end }}
- name: ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER
  value: {{ .Values.archestra.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster | quote }}
{{- if .Values.archestra.orchestrator.kubernetes.clusterDomain }}
- name: ARCHESTRA_ORCHESTRATOR_K8S_CLUSTER_DOMAIN
  value: {{ .Values.archestra.orchestrator.kubernetes.clusterDomain | quote }}
{{- end }}
{{- if and .Values.archestra.orchestrator.kubernetes.rbac.environmentNamespaces (not (hasKey .Values.archestra.env "ARCHESTRA_ORCHESTRATOR_ENVIRONMENT_NAMESPACES")) }}
- name: ARCHESTRA_ORCHESTRATOR_ENVIRONMENT_NAMESPACES
  value: {{ join "," .Values.archestra.orchestrator.kubernetes.rbac.environmentNamespaces | quote }}
{{- end }}
{{/* always emitted: "false" is the backend kill switch, and it must reach the
     backend even when a runner host arrives through archestra.env. */}}
{{- if not (hasKey .Values.archestra.env "ARCHESTRA_CODE_RUNTIME_ENABLED") }}
- name: ARCHESTRA_CODE_RUNTIME_ENABLED
  value: {{ .Values.archestra.codeRuntime.enabled | quote }}
{{- end }}
{{/* Back-compat: the removed chart-deployed engine's bring-your-own pointer
     lived at archestra.codeRuntime.dagger.runnerHost. Carry a leftover value
     into the env var so an upgrade keeps routing to that engine instead of
     silently dropping it and provisioning engines in-cluster. An explicit
     archestra.env entry wins. */}}
{{- $leftoverRunnerHost := dig "dagger" "runnerHost" "" .Values.archestra.codeRuntime }}
{{- if and $leftoverRunnerHost (not (hasKey .Values.archestra.env "ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST")) }}
- name: ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST
  value: {{ $leftoverRunnerHost | quote }}
{{- end }}
{{- if .Values.archestra.diagnostics.enabled }}
- name: ARCHESTRA_NODE_DIAGNOSTIC_DIR
  value: "/var/diagnostics"
{{- if gt (int .Values.archestra.diagnostics.heapSnapshotsNearHeapLimit) 0 }}
- name: ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT
  value: {{ .Values.archestra.diagnostics.heapSnapshotsNearHeapLimit | quote }}
{{- end }}
{{- end }}
{{- if eq .Values.archestra.fileStorage.provider "filesystem" }}
- name: ARCHESTRA_FILE_STORAGE_PROVIDER
  value: "filesystem"
- name: ARCHESTRA_FILE_STORAGE_FILESYSTEM_ROOT
  value: {{ .Values.archestra.fileStorage.filesystem.mountPath | quote }}
{{- end }}
{{- range $key, $value := .Values.archestra.env }}
{{/* Check if env var is in the explicit sensitive list OR matches ARCHESTRA_CHAT_*_API_KEY pattern */}}
{{- $isSensitive := or (has $key $sensitiveEnvVars) (and (hasPrefix "ARCHESTRA_CHAT_" $key) (hasSuffix "_API_KEY" $key)) }}
{{/* Only use secretKeyRef for sensitive vars with non-empty values; empty values are set as regular env vars */}}
{{- if and $isSensitive $value }}
{{/* Sensitive env vars with values are stored in the Secret and referenced via secretKeyRef */}}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: {{ include "archestra-platform.authSecretName" $ }}
      key: {{ $key | lower | replace "_" "-" }}
{{- /*
optional: the pre-upgrade migrate Job renders from the NEW templates but runs
BEFORE the upgraded Secret is applied, so on the upgrade that first introduces
one of these keys the referenced Secret key does not exist yet and a required
ref would wedge the Job in CreateContainerConfigError until its deadline.
Migrations don't need the key; app pods start after the Secret update in the
same apply, and the application's own fail-closed key check (canary) catches a
genuinely missing key loudly at startup.
*/}}
{{- if has $key (list "ARCHESTRA_CONTENT_ENCRYPTION_SECRET" "ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS") }}
      optional: true
{{- end }}
{{- else }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- end }}
{{- range .Values.archestra.envFromSecrets }}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: {{ .secretKey }}
{{- end }}
{{- range .Values.archestra.envWithValueFrom }}
- name: {{ .name }}
  valueFrom:
    {{- toYaml .valueFrom | nindent 4 }}
{{- end }}
{{- end }}

{{/*
Expose declared memory resources in MiB so the production Node launcher can
derive a V8 old-space ceiling. Only emit fields that are explicitly configured:
resourceFieldRef otherwise falls back to node allocatable memory.

Callers may pass `reservedMib` for a container that runs something else besides
this Node process. The launcher subtracts it from the limit before applying its
percentage, so the split is taken over memory this process can actually use.
Omit it for single-process containers.
*/}}
{{- define "archestra-platform.nodeMemoryEnv" -}}
{{- $resources := .resources | default dict -}}
{{- $requests := get $resources "requests" | default dict -}}
{{- $limits := get $resources "limits" | default dict -}}
{{- if .reservedMib }}
- name: ARCHESTRA_NODE_MEMORY_RESERVED_MIB
  value: {{ .reservedMib | quote }}
{{- end }}
{{- if get $requests "memory" }}
- name: ARCHESTRA_NODE_MEMORY_REQUEST_MIB
  valueFrom:
    resourceFieldRef:
      containerName: {{ .containerName }}
      resource: requests.memory
      divisor: 1Mi
{{- end }}
{{- if get $limits "memory" }}
- name: ARCHESTRA_NODE_MEMORY_LIMIT_MIB
  valueFrom:
    resourceFieldRef:
      containerName: {{ .containerName }}
      resource: limits.memory
      divisor: 1Mi
{{- end }}
{{- end }}

{{/*
Auth secret name for the Archestra Platform
*/}}
{{- define "archestra-platform.authSecretName" -}}
{{- default (printf "%s-auth" (include "archestra-platform.fullname" .)) .Values.archestra.authSecret.existingSecretName -}}
{{- end }}

{{/*
Hook-only auth secret name for the database migration Job.
*/}}
{{- define "archestra-platform.migrationJobAuthSecretName" -}}
{{- printf "%s-migrate-auth" (include "archestra-platform.fullname" .) -}}
{{- end }}

{{/*
Auth secret key for the Archestra Platform
*/}}
{{- define "archestra-platform.authSecretKey" -}}
{{- if and (not .Values.archestra.authSecret.existingSecretName) (ne .Values.archestra.authSecret.existingSecretKey "auth-secret") -}}
{{- fail "archestra.authSecret.existingSecretKey requires archestra.authSecret.existingSecretName to also be set." -}}
{{- end -}}
{{- default "auth-secret" .Values.archestra.authSecret.existingSecretKey -}}
{{- end }}

{{/*
Diagnostics PVC claim name
*/}}
{{- define "archestra-platform.diagnosticsClaimName" -}}
{{- default (printf "%s-diagnostics" (include "archestra-platform.fullname" .)) .Values.archestra.diagnostics.existingClaimName -}}
{{- end }}

{{/*
File storage PVC claim name
*/}}
{{- define "archestra-platform.fileStorageClaimName" -}}
{{- default (printf "%s-file-storage" (include "archestra-platform.fullname" .)) .Values.archestra.fileStorage.filesystem.existingClaim -}}
{{- end }}

{{/*
ServiceAccount name for the Archestra Platform
*/}}
{{- define "archestra-platform.serviceAccountName" -}}
{{- if .Values.archestra.orchestrator.kubernetes.serviceAccount.create }}
{{- default (include "archestra-platform.fullname" .) .Values.archestra.orchestrator.kubernetes.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.archestra.orchestrator.kubernetes.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
RBAC rules granting the platform ServiceAccount the permissions it needs to
manage MCP server workloads AND the Dagger sandbox engines it provisions per
environment and per organization (StatefulSet + engine-config ConfigMap + egress
NetworkPolicy, reached via pods/exec + pods/attach) in a namespace. The chart
deploys no engine itself; this Role is what lets the backend create them. Shared
by the release-namespace Role and the per-namespace Roles generated from
rbac.environmentNamespaces, so both grant exactly the same access (no drift).
*/}}
{{- define "archestra-platform.mcpManagerRules" -}}
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["get", "create"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get", "list"]
- apiGroups: [""]
  resources: ["pods/attach"]
  verbs: ["get", "create"]
- apiGroups: [""]
  resources: ["services"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
# ConfigMaps for the per-environment Dagger engine config (engine.json).
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
# Deployments for MCP servers; StatefulSets for the per-environment Dagger engine.
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
# Jobs run Agent background executions. The control plane only needs to create,
# inspect, and remove them; it never mutates an existing Job or manages CronJobs.
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "create", "delete"]
- apiGroups: ["batch"]
  resources: ["jobs/status"]
  verbs: ["get"]
# DaemonSet for the MCP image pre-puller, which keeps every node's image cache
# warm so a hibernated MCP server wakes without reaching the registry. Narrower
# than the rule above on purpose: the reconciler only reads and rewrites its own
# single DaemonSet, and never watches one.
- apiGroups: ["apps"]
  resources: ["daemonsets"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
# Standard Kubernetes NetworkPolicy for IP/CIDR egress rules.
- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
# CiliumNetworkPolicy for DNS/FQDN egress rules on Cilium-enabled clusters.
- apiGroups: ["cilium.io"]
  resources: ["ciliumnetworkpolicies"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
# GKE FQDNNetworkPolicy for DNS/FQDN egress rules on supported GKE clusters.
- apiGroups: ["networking.gke.io"]
  resources: ["fqdnnetworkpolicies"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
# EKS Auto Mode ApplicationNetworkPolicy for DNS/FQDN egress rules.
- apiGroups: ["networking.k8s.aws"]
  resources: ["applicationnetworkpolicies"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
{{- end }}

{{/*
Worker selector labels
*/}}
{{- define "archestra-platform.workerSelectorLabels" -}}
app.kubernetes.io/name: {{ include "archestra-platform.name" . }}-worker
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: worker
{{- end }}

{{/*
Worker labels
*/}}
{{- define "archestra-platform.workerLabels" -}}
helm.sh/chart: {{ include "archestra-platform.chart" . }}
{{ include "archestra-platform.workerSelectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: archestra
{{- end }}

{{/*
Renderer selector labels (app-recording video render service)
*/}}
{{- define "archestra-platform.rendererSelectorLabels" -}}
app.kubernetes.io/name: {{ include "archestra-platform.name" . }}-renderer
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: renderer
{{- end }}

{{/*
Renderer labels
*/}}
{{- define "archestra-platform.rendererLabels" -}}
helm.sh/chart: {{ include "archestra-platform.chart" . }}
{{ include "archestra-platform.rendererSelectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: archestra
{{- end }}

{{/*
Database migration Job labels.

The name label is suffixed with `-migrate` so the platform Service selector
never routes traffic to the short-lived migration pod.
*/}}
{{- define "archestra-platform.migrationJobLabels" -}}
helm.sh/chart: {{ include "archestra-platform.chart" . }}
app.kubernetes.io/name: {{ include "archestra-platform.name" . }}-migrate
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: migrate
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: archestra
{{- end }}

{{/*
NetworkPolicy enforcement probe labels.

The name label is suffixed with `-netpol-probe` so the platform Service selector
never routes traffic to a probe pod. The backend finds the probe pods by the
`app.kubernetes.io/component` label, so it must stay in step with the selector in
`backend/src/k8s/network-policy-probe.ts`.
*/}}
{{- define "archestra-platform.networkPolicyProbeLabels" -}}
helm.sh/chart: {{ include "archestra-platform.chart" . }}
app.kubernetes.io/name: {{ include "archestra-platform.name" . }}-netpol-probe
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: netpol-probe
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: archestra
{{- end }}

{{/*
Host the probe pods try to reach.

Defaults to the platform's own Service: pod -> ClusterIP -> pod is the datapath
the product's real egress policies govern and it needs no internet access. Do not
substitute cluster DNS or the Kubernetes API: NodeLocal DNSCache answers from a
link-local address on the same node, and on kind/docker-desktop the apiserver
ClusterIP resolves to the node itself. Several dataplanes leave those node-local
paths unfiltered, which would report a non-enforcing cluster as enforcing.

Fully qualified (trailing dot) so the resolver does not walk the search list.
Under the deny-all arm every one of those lookups has to time out, which is far
slower than the single failure the probe actually needs.
*/}}
{{- define "archestra-platform.networkPolicyProbeTarget" -}}
{{- $domain := .Values.archestra.orchestrator.kubernetes.clusterDomain | default "cluster.local" -}}
{{- .Values.archestra.networkPolicyProbe.targetHost | default (printf "%s.%s.svc.%s." (include "archestra-platform.fullname" .) .Release.Namespace $domain) -}}
{{- end }}

{{/*
Control arm: establish that the target is reachable at all.

Patient and stops at the first success, because on a fresh install the platform
may still be booting. If this arm never connects the run proves nothing and the
treatment result must be discarded rather than read as "enforced".

The verdict also travels in the container's termination message: the treatment
pod is network-isolated by construction and so cannot report to the API server
itself, but the kubelet copies /dev/termination-log into the pod status on its
behalf, and the backend reads it from there.

Always exits 0 — this is a diagnostic, and a failing hook would abort the release.
Avoids $(...) and $((...)), which Kubernetes would try to expand as variable
references before the shell ever sees them. Each attempt is wrapped in `timeout`
because a blocked path stalls on DNS as well as the connection, well past what
the connect timeout implies.

25 attempts at 3s covers a platform that is still booting while staying well
inside Helm's default --timeout, which the hook wait counts against.

Takes a dict of: host. The port is the chart's fixed backend Service port.
*/}}
{{- define "archestra-platform.networkPolicyProbeControlScript" -}}
command: ["/bin/sh", "-c"]
args:
  - |
    result=blocked
    i=0
    while [ $i -lt 25 ]; do
      if timeout 3 nc -z -w 2 {{ .host }} 9000 2>/dev/null; then
        result=reachable
        break
      fi
      i=`expr $i + 1`
      sleep 1
    done
    printf '%s' "$result" > /dev/termination-log
    {{- /*
      Silent when the target answers: a healthy release should cost the operator
      no output at all.

      When the target never answers, the treatment arm is blocked for that same
      reason rather than by any policy, and cannot tell the two apart. This arm
      is the only one that can, so it reports the run measured nothing — and
      says it without depending on which line Helm printed first.
    */}}
    if [ "$result" = blocked ]; then
      echo "[archestra] ⚠️ ⚠️ ⚠️  NETWORK POLICY CHECK INCONCLUSIVE  ⚠️ ⚠️ ⚠️  Could not reach {{ .host }}:9000, so enforcement was never measured — environment egress rules (MCP servers, code sandboxes) may be accepted and then silently ignored, leaving pods able to reach cloud metadata endpoints and private cluster ranges. Re-run once the platform is up to get a verdict — see https://archestra.ai/docs/platform-deployment#ssrf-protection-for-mcp-server-pods"
    fi
    exit 0
{{- end }}

{{/*
Treatment arm: decide whether the deny-all policy selecting this pod bites.

Two safeguards, both learned from watching this misreport on a cluster that does
enforce:

Settles first. A dataplane programs a new pod's rules asynchronously, so the
container can start and connect in the gap before they land. Taking the first
attempt as the answer turns that race into a confident "not enforced".

Then takes a majority of five attempts rather than trusting any single one. A
lone success cannot outvote a genuinely enforced path, and a lone blip on an
unenforced cluster cannot fake enforcement — the direction that would hide the
warning this probe exists to raise. Every attempt runs; there is no early exit,
since both error directions need the full sample.

Takes a dict of: host. The port is the chart's fixed backend Service port.
*/}}
{{- define "archestra-platform.networkPolicyProbeTreatmentScript" -}}
command: ["/bin/sh", "-c"]
args:
  - |
    sleep 5
    ok=0
    i=0
    while [ $i -lt 5 ]; do
      if timeout 3 nc -z -w 2 {{ .host }} 9000 2>/dev/null; then
        ok=`expr $ok + 1`
      fi
      i=`expr $i + 1`
      sleep 1
    done
    if [ `expr $ok \* 2` -gt 5 ]; then
      result=reachable
    else
      result=blocked
    fi
    printf '%s' "$result" > /dev/termination-log
    {{- /*
      Speaks only to warn. Being blocked is also what a target that never came up
      looks like from inside this pod, so an all-clear here would sometimes
      announce enforcement nobody measured. The verdict still leaves in the
      termination message, where the platform resolves it against the control arm
      and can claim enforcement holding both halves of the evidence.

      One line, because the two supported Helm majors disagree about hook output:
      Helm 4 routes it through its structured logger, where the whole pod log
      becomes one `level=... msg="..."` record and every newline arrives as a
      literal \n, while Helm 3 copies the stream verbatim. A stacked banner
      renders on 3 and reaches 4 as a row of escapes. Emoji survive both.
    */}}
    if [ "$result" = reachable ]; then
      echo "[archestra] ⚠️ ⚠️ ⚠️  NETWORK POLICY NOT ENFORCED  ⚠️ ⚠️ ⚠️  Environment egress rules (MCP servers, code sandboxes) are accepted and then silently ignored, so pods reach cloud metadata endpoints and private cluster ranges — see https://archestra.ai/docs/platform-deployment#ssrf-protection-for-mcp-server-pods"
    fi
    exit 0
{{- end }}

{{/*
Shared init containers for both platform and worker Deployments.
Handles Vault secret injection, pgvector extension setup, and PostgreSQL readiness.
*/}}
{{- define "archestra-platform.initContainers" -}}
{{- if .Values.archestra.initContainers.vaultSecrets.enabled }}
# Vault secret injection init container
- name: vault-secrets
  image: {{ include "archestra-platform.image" . }}
  workingDir: /app/backend
  env:
    {{- include "archestra-platform.env" . | nindent 4 }}
    - name: VAULT_INJECTOR_SECRETS
      value: {{ .Values.archestra.initContainers.vaultSecrets.secrets | toJson | quote }}
  command: ["node", "--enable-source-maps", "dist/standalone-scripts/vault-env-injector.ee.mjs"]
  volumeMounts:
    - name: vault-secrets
      mountPath: /vault/secrets
{{- end }}
{{- if .Values.postgresql.enabled }}
# Ensure the pgvector extension exists in the application database.
- name: setup-postgres-extensions
  {{- /* Honor the digest pin the same way the Bitnami subchart does: with a digest, the tag is informational and the digest wins. */}}
  image: {{ printf "%s:%s" (.Values.postgresql.image.repository | default "bitnami/postgresql") (.Values.postgresql.image.tag | default "latest") }}{{ with .Values.postgresql.image.digest }}@{{ . }}{{ end }}
  {{- with .Values.archestra.initContainers.resources }}
  resources:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  env:
    - name: PGPASSWORD
      valueFrom:
        secretKeyRef:
          name: {{ include "archestra-platform.fullname" . }}-postgresql
          key: postgres-password
  command:
    - sh
    - -c
    - |
      max_attempts={{ .Values.archestra.initContainers.waitForPostgres.timeoutSeconds | default 300 }}
      attempt=0
      until pg_isready -h {{ include "archestra-platform.fullname" . }}-postgresql -U postgres; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge "$max_attempts" ]; then
          echo "PostgreSQL did not become ready after ${max_attempts}s - giving up" >&2
          exit 1
        fi
        echo "Waiting for PostgreSQL... (${attempt}/${max_attempts})"
        sleep 1
      done
      psql -h {{ include "archestra-platform.fullname" . }}-postgresql -U postgres -d {{ .Values.postgresql.auth.database }} -c "CREATE EXTENSION IF NOT EXISTS vector;"
{{- end }}
- name: wait-for-postgres
  image: {{ .Values.archestra.initContainers.busyboxImage | default "busybox:1.36" }}
  {{- with .Values.archestra.initContainers.resources }}
  resources:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  env:
    {{- include "archestra-platform.env" . | nindent 4 }}
  {{- if .Values.archestra.initContainers.vaultSecrets.enabled }}
  volumeMounts:
    - name: vault-secrets
      mountPath: /vault/secrets
      readOnly: true
  {{- end }}
  command:
    - sh
    - -c
    - |
      {{- if .Values.archestra.initContainers.waitForPostgres.enabled }}
      # Source Vault secrets if available (may override ARCHESTRA_DATABASE_URL)
      if [ -f /vault/secrets/env ]; then
        set -a
        . /vault/secrets/env
        set +a
      fi

      # Parse host and port from ARCHESTRA_DATABASE_URL
      # Format: postgresql://user:pass@host[:port]/database
      DB_URL="${ARCHESTRA_DATABASE_URL##*@}"  # Remove prefix up to last @ (handles passwords with @)
      HOST_PORT="${DB_URL%%/*}"               # Remove /database suffix
      HOST="${HOST_PORT%%:*}"                 # Extract host
      # Extract port, defaulting to 5432 if not specified
      case "$HOST_PORT" in
        *:*) PORT="${HOST_PORT##*:}" ;;
        *)   PORT="5432" ;;
      esac

      echo "Waiting for PostgreSQL at ${HOST}:${PORT}..."
      max_attempts={{ .Values.archestra.initContainers.waitForPostgres.timeoutSeconds | default 300 }}
      attempt=0
      until nc -z "${HOST}" "${PORT}"; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge "$max_attempts" ]; then
          echo "PostgreSQL at ${HOST}:${PORT} did not become reachable after ${max_attempts}s - giving up" >&2
          exit 1
        fi
        echo "PostgreSQL is unavailable - sleeping (${attempt}/${max_attempts})"
        sleep 1
      done
      echo "PostgreSQL is up - continuing"
      {{- else }}
      echo "Skipping PostgreSQL readiness check"
      {{- end }}
{{- end }}

{{/*
Worker-only init container that blocks worker startup until the web Deployment
has applied database migrations.

This is reliable on fresh installs, where no previous web pods exist. Upgrades
are covered by the pre-upgrade migration Job.
*/}}
{{- define "archestra-platform.waitForMigrationsInitContainer" -}}
{{- if .Values.archestra.initContainers.waitForMigrations.enabled }}
- name: wait-for-migrations
  image: {{ .Values.archestra.initContainers.busyboxImage | default "busybox:1.36" }}
  {{- with .Values.archestra.initContainers.resources }}
  resources:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  command:
    - sh
    - -c
    - |
      HOST={{ include "archestra-platform.fullname" . | quote }}
      PORT=9000
      echo "Waiting for migrations (platform web server at ${HOST}:${PORT})..."
      max_attempts={{ .Values.archestra.initContainers.waitForMigrations.timeoutSeconds | default 600 }}
      attempt=0
      until nc -z "${HOST}" "${PORT}"; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge "$max_attempts" ]; then
          echo "Platform web server at ${HOST}:${PORT} did not become reachable after ${max_attempts}s - giving up" >&2
          exit 1
        fi
        echo "Platform web server is unavailable - sleeping (${attempt}/${max_attempts})"
        sleep 1
      done
      echo "Platform web server is up - migrations applied, continuing"
{{- end }}
{{- end }}

{{/*
Shared volumes for both platform and worker Deployments.
*/}}
{{- define "archestra-platform.volumes" -}}
{{- if or (and .Values.archestra.orchestrator.kubernetes.kubeconfig.enabled .Values.archestra.orchestrator.kubernetes.kubeconfig.secretName) .Values.archestra.initContainers.vaultSecrets.enabled .Values.archestra.diagnostics.enabled (eq .Values.archestra.fileStorage.provider "filesystem") .Values.archestra.extraVolumes }}
volumes:
  {{- if and .Values.archestra.orchestrator.kubernetes.kubeconfig.enabled .Values.archestra.orchestrator.kubernetes.kubeconfig.secretName }}
  - name: kubeconfig
    secret:
      secretName: {{ .Values.archestra.orchestrator.kubernetes.kubeconfig.secretName }}
  {{- end }}
  {{- if .Values.archestra.initContainers.vaultSecrets.enabled }}
  - name: vault-secrets
    emptyDir:
      medium: Memory
  {{- end }}
  {{- if .Values.archestra.diagnostics.enabled }}
  - name: diagnostics
    persistentVolumeClaim:
      claimName: {{ include "archestra-platform.diagnosticsClaimName" . }}
  {{- end }}
  {{- if eq .Values.archestra.fileStorage.provider "filesystem" }}
  - name: file-storage
    persistentVolumeClaim:
      claimName: {{ include "archestra-platform.fileStorageClaimName" . }}
  {{- end }}
  {{- with .Values.archestra.extraVolumes }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
{{- end }}
{{- end }}

{{/*
Shared volume mounts for the main container.
*/}}
{{- define "archestra-platform.volumeMounts" -}}
{{- if or (and .Values.archestra.orchestrator.kubernetes.kubeconfig.enabled .Values.archestra.orchestrator.kubernetes.kubeconfig.secretName) .Values.archestra.initContainers.vaultSecrets.enabled .Values.archestra.diagnostics.enabled (eq .Values.archestra.fileStorage.provider "filesystem") .Values.archestra.extraVolumeMounts }}
volumeMounts:
  {{- if and .Values.archestra.orchestrator.kubernetes.kubeconfig.enabled .Values.archestra.orchestrator.kubernetes.kubeconfig.secretName }}
  - name: kubeconfig
    mountPath: {{ .Values.archestra.orchestrator.kubernetes.kubeconfig.mountPath }}
    readOnly: true
  {{- end }}
  {{- if .Values.archestra.initContainers.vaultSecrets.enabled }}
  - name: vault-secrets
    mountPath: /vault/secrets
    readOnly: true
  {{- end }}
  {{- if .Values.archestra.diagnostics.enabled }}
  - name: diagnostics
    mountPath: /var/diagnostics
    readOnly: false
  {{- end }}
  {{- if eq .Values.archestra.fileStorage.provider "filesystem" }}
  - name: file-storage
    mountPath: {{ .Values.archestra.fileStorage.filesystem.mountPath }}
    readOnly: false
  {{- end }}
  {{- with .Values.archestra.extraVolumeMounts }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
{{- end }}
{{- end }}

{{/*
Vault secrets command wrapper for the main container.
Sources /vault/secrets/env before exec'ing the given entrypoint command.
Usage: Pass the desired entrypoint as the argument.
*/}}
{{- define "archestra-platform.vaultSecretsCommand" -}}
command: ["/bin/sh", "-c"]
args:
  - |
    if [ -f /vault/secrets/env ]; then
      set -a
      . /vault/secrets/env
      set +a
    fi
    exec {{ . }}
{{- end }}

{{/*
Full container image reference for the Archestra Platform.
This helper constructs the image reference smartly:
- If archestra.image already contains a tag (colon after the last slash), use it as-is
- Otherwise, append the imageTag value

This maintains backward compatibility with existing deployments that set the full image:tag
in archestra.image, while also supporting the new imageTag field used by release-please.

Examples:
  image: "archestra/platform", imageTag: "1.0.0" -> "archestra/platform:1.0.0"
  image: "archestra/platform:ci-test", imageTag: "1.0.0" -> "archestra/platform:ci-test"
  image: "registry.io:5000/archestra/platform", imageTag: "1.0.0" -> "registry.io:5000/archestra/platform:1.0.0"
*/}}
{{- define "archestra-platform.image" -}}
{{- $image := .Values.archestra.image -}}
{{- $imageTag := .Values.archestra.imageTag -}}
{{- /* Extract the part after the last slash to check for a tag */ -}}
{{- $lastSlashIndex := (sub (len $image) (len (trimPrefix "/" (regexReplaceAll ".*/" $image "")))) -}}
{{- $afterLastSlash := regexReplaceAll ".*/" $image "" -}}
{{- /* Check if there's a colon in the image name part (after the last slash) */ -}}
{{- if contains ":" $afterLastSlash -}}
{{- /* Image already has a tag, use as-is */ -}}
{{- $image -}}
{{- else -}}
{{- /* No tag in image, append imageTag */ -}}
{{- printf "%s:%s" $image $imageTag -}}
{{- end -}}
{{- end }}
