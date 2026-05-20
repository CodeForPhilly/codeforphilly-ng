#!/usr/bin/env bash
# Spawn `git upload-pack` inside the running sandbox pod so you can fetch from
# the pod's PVC-backed data clone as a git remote. Designed to be plumbed into
# git's `ext::` transport — see docs/operations/runbook.md → "Fetch from the
# pod's data clone".
#
# Env (all optional, sensible defaults baked in):
#   CFP_POD_KUBECONFIG  — path to kubeconfig (default ~/.kube/cfp-sandbox-cluster-kubeconfig.yaml)
#   CFP_POD_NAMESPACE   — k8s namespace                (default codeforphilly-rewrite-sandbox)
#   CFP_POD_SELECTOR    — label selector for the pod   (default app.kubernetes.io/name=codeforphilly)
#   CFP_POD_DATA_PATH   — repo path inside the pod     (default /app/data)
set -euo pipefail

KUBECONFIG_PATH="${CFP_POD_KUBECONFIG:-$HOME/.kube/cfp-sandbox-cluster-kubeconfig.yaml}"
NAMESPACE="${CFP_POD_NAMESPACE:-codeforphilly-rewrite-sandbox}"
SELECTOR="${CFP_POD_SELECTOR:-app.kubernetes.io/name=codeforphilly}"
DATA_PATH="${CFP_POD_DATA_PATH:-/app/data}"

POD=$(kubectl --kubeconfig="$KUBECONFIG_PATH" -n "$NAMESPACE" \
  get pod -l "$SELECTOR" --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}')

if [[ -z "$POD" ]]; then
  echo "git-pod-uploadpack: no Running pod matched $SELECTOR in $NAMESPACE" >&2
  exit 1
fi

exec kubectl --kubeconfig="$KUBECONFIG_PATH" -n "$NAMESPACE" \
  exec -i "$POD" -- git upload-pack "$DATA_PATH"
