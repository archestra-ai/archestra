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
{{- end }}

{{/*
Selector labels
*/}}
{{- define "archestra-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "archestra-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Environment variables for the Archestra Platform container
*/}}
{{- define "archestra-platform.env" -}}
- name: DATABASE_URL
  value: {{ if .Values.postgresql.external_database_url }}{{ .Values.postgresql.external_database_url }}{{ else }}postgresql://{{ .Values.postgresql.auth.username }}:{{ .Values.postgresql.auth.password }}@{{ include "archestra-platform.fullname" . }}-postgresql:5432/{{ .Values.postgresql.auth.database }}{{ end }}
{{- if .Values.archestra.kubernetes.namespace }}
- name: K8S_NAMESPACE
  value: {{ .Values.archestra.kubernetes.namespace | quote }}
{{- end }}
{{- if .Values.archestra.kubernetes.baseImage }}
- name: MCP_SERVER_BASE_IMAGE
  value: {{ .Values.archestra.kubernetes.baseImage | quote }}
{{- end }}
{{- if and .Values.archestra.kubernetes.kubeconfig.enabled .Values.archestra.kubernetes.kubeconfig.secretName }}
- name: KUBECONFIG
  value: {{ printf "%s/config" .Values.archestra.kubernetes.kubeconfig.mountPath | quote }}
{{- end }}
- name: USE_IN_CLUSTER_KUBECONFIG
  value: {{ .Values.archestra.kubernetes.useInClusterConfig | quote }}
{{- range $key, $value := .Values.archestra.env }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- end }}

{{/*
PostgreSQL host for database connectivity checks
*/}}
{{- define "archestra-platform.postgresql.host" -}}
{{- if .Values.postgresql.external_database_url -}}
{{- regexReplaceAll "^postgresql://[^@]+@([^:/]+).*$" .Values.postgresql.external_database_url "${1}" -}}
{{- else -}}
{{- include "archestra-platform.fullname" . }}-postgresql
{{- end -}}
{{- end }}

{{/*
PostgreSQL port for database connectivity checks
*/}}
{{- define "archestra-platform.postgresql.port" -}}
{{- if .Values.postgresql.external_database_url -}}
{{- regexReplaceAll "^postgresql://[^@]+@[^:]+:([0-9]+).*$" .Values.postgresql.external_database_url "${1}" -}}
{{- else -}}
5432
{{- end -}}
{{- end }}
