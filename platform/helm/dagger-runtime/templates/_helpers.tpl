{{/*
expand the name of the chart.
*/}}
{{- define "archestra-dagger-runtime.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
create a default fully qualified app name.
*/}}
{{- define "archestra-dagger-runtime.fullname" -}}
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
create chart name and version as used by the chart label.
*/}}
{{- define "archestra-dagger-runtime.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
common labels.
*/}}
{{- define "archestra-dagger-runtime.labels" -}}
helm.sh/chart: {{ include "archestra-dagger-runtime.chart" . }}
{{ include "archestra-dagger-runtime.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: archestra
{{- end }}

{{/*
selector labels for chart-owned resources.
*/}}
{{- define "archestra-dagger-runtime.selectorLabels" -}}
app.kubernetes.io/name: {{ include "archestra-dagger-runtime.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
service account name for the Dagger engine pod.
*/}}
{{- define "archestra-dagger-runtime.serviceAccountName" -}}
{{- default (include "archestra-dagger-runtime.fullname" .) .Values.serviceAccount.name }}
{{- end }}

{{/*
selector labels applied by the pinned Dagger subchart to the engine pod.
*/}}
{{- define "archestra-dagger-runtime.engineSelectorLabels" -}}
name: {{ printf "%s-engine" (include "archestra-dagger-runtime.fullname" .) }}
{{- end }}
