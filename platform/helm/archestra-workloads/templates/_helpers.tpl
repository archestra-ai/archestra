{{- define "archestra-workloads.serviceAccountName" -}}
{{- default .Release.Name .Values.serviceAccount.name -}}
{{- end }}

{{- define "archestra-workloads.namespaces" -}}
{{- if .Values.namespaces -}}
{{- toJson .Values.namespaces -}}
{{- else -}}
{{- toJson (list .Release.Namespace) -}}
{{- end -}}
{{- end }}

{{- define "archestra-workloads.labels" -}}
app.kubernetes.io/name: archestra-workloads
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Every permission the platform uses in an environment's own cluster. Kept equal
to ENVIRONMENT_CLUSTER_PERMISSIONS in the platform backend
(backend/src/k8s/environment-cluster-permissions.ts) by a backend test.
*/}}
{{- define "archestra-workloads.rules" -}}
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
# streamable-http MCP servers are reached through the API server.
- apiGroups: [""]
  resources: ["pods/portforward"]
  verbs: ["get", "create"]
- apiGroups: [""]
  resources: ["services"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
- apiGroups: [""]
  resources: ["persistentvolumeclaims"]
  verbs: ["get", "list", "delete"]
- apiGroups: ["agents.x-k8s.io"]
  resources: ["sandboxes"]
  verbs: ["get", "list", "create", "patch", "delete"]
- apiGroups: ["agents.x-k8s.io"]
  resources: ["sandboxes/status"]
  verbs: ["get"]
- apiGroups: ["extensions.agents.x-k8s.io"]
  resources: ["sandboxclaims"]
  verbs: ["get", "list", "create", "patch", "delete"]
- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
- apiGroups: ["cilium.io"]
  resources: ["ciliumnetworkpolicies"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
- apiGroups: ["networking.gke.io"]
  resources: ["fqdnnetworkpolicies"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
- apiGroups: ["networking.k8s.aws"]
  resources: ["applicationnetworkpolicies"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
{{- end }}
