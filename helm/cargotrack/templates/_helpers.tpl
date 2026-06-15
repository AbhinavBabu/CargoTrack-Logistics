{{- define "cargotrack.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "cargotrack.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "cargotrack.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "cargotrack.selectorLabels" -}}
app.kubernetes.io/name: {{ .Values.global.environment }}-{{ include "cargotrack.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
