{{- define "codeforphilly.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "codeforphilly.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "codeforphilly.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "codeforphilly.labels" -}}
helm.sh/chart: {{ include "codeforphilly.chart" . }}
{{ include "codeforphilly.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "codeforphilly.selectorLabels" -}}
app.kubernetes.io/name: {{ include "codeforphilly.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "codeforphilly.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "codeforphilly.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "codeforphilly.dataPvcName" -}}
{{- default (printf "%s-data" (include "codeforphilly.fullname" .)) .Values.dataRepo.pvc.name -}}
{{- end -}}

{{- define "codeforphilly.privatePvcName" -}}
{{- default (printf "%s-private" (include "codeforphilly.fullname" .)) .Values.privateStorage.pvc.name -}}
{{- end -}}
