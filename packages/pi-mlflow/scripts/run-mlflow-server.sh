#!/usr/bin/env bash
# Start a local MLflow Tracking Server suitable for pi-mlflow / the TS SDK.
#
# The TypeScript mlflow-tracing client expects experiment artifact locations
# of the form mlflow-artifacts:/… (not bare file paths or raw http:// roots).
# --serve-artifacts + --artifacts-destination is the configuration that
# produces those tags and accepts PUT of traces.json.
#
set -euo pipefail

ROOT="${MLFLOW_SERVER_DIR:-${HOME}/.mlflow-server}"
PORT="${MLFLOW_SERVER_PORT:-${PORT:-5055}}"
HOST="${MLFLOW_SERVER_HOST:-127.0.0.1}"
MLFLOW_BIN="${MLFLOW_BIN:-mlflow}"
# Comma-separated Host header patterns (fnmatch) MLflow will accept.
# Port patterns (e.g. 127.0.0.1:5055) are included so direct IP:port connections succeed.
ALLOWED_HOSTS="${MLFLOW_ALLOWED_HOSTS:-localhost,localhost:*,127.0.0.1,127.0.0.1:*,[::1],[::1]:*}"
CORS_ORIGINS="${MLFLOW_CORS_ALLOWED_ORIGINS:-http://127.0.0.1:${PORT},http://localhost:${PORT}}"

mkdir -p "$ROOT/mlartifacts"
export PATH="${PATH}"

read -r -a MLFLOW_CMD <<< "${MLFLOW_BIN}"

if ! command -v "${MLFLOW_CMD[0]}" >/dev/null 2>&1; then
  echo "mlflow not found on PATH. Install with e.g.:" >&2
  echo "  python3.12 -m venv /tmp/pi-mlflow-venv && /tmp/pi-mlflow-venv/bin/pip install mlflow" >&2
  echo "  export MLFLOW_BIN=/tmp/pi-mlflow-venv/bin/mlflow" >&2
  echo "  # or: uvx --from mlflow mlflow …" >&2
  exit 1
fi

echo "Starting MLflow on http://${HOST}:${PORT}"
echo "  backend:  sqlite:///${ROOT}/mlruns.db"
echo "  artifacts destination: ${ROOT}/mlartifacts"
echo "  allowed hosts: ${ALLOWED_HOSTS}"
echo

exec "${MLFLOW_CMD[@]}" server \
  --host "$HOST" \
  --port "$PORT" \
  --backend-store-uri "sqlite:///${ROOT}/mlruns.db" \
  --serve-artifacts \
  --artifacts-destination "${ROOT}/mlartifacts" \
  --allowed-hosts "${ALLOWED_HOSTS}" \
  --cors-allowed-origins "${CORS_ORIGINS}"
