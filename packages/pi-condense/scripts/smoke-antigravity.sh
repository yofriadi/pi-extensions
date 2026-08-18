#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke-antigravity.sh --model <google-antigravity/model> [--prompt <text>] [--provider-extension <path>] [--agent-dir <path>] [--keep]

Run a real, authenticated pi-condense smoke in an isolated session. This helper
never claims that the configured summarizer succeeded: inspect the printed
session JSONL and the provider/fallback outcome yourself before recording the
live-smoke task.

Required:
  --model MODEL                 A google-antigravity/<model> identifier.

Optional:
  --prompt TEXT                 Prompt that asks Pi to run a large tool call, then /pruner now.
  --provider-extension PATH     Antigravity provider extension (default: $PI_ANTIGRAVITY_EXTENSION).
  --agent-dir PATH              Existing authenticated pi agent dir to copy auth.json from
                                (default: ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}).
  --keep                        Keep the temporary directory after the run.

The agent directory must already contain valid Antigravity authentication. The
provider extension is intentionally explicit so this helper cannot silently
exercise a different provider.
EOF
}

MODEL=""
PROMPT='Use the bash tool to print a 6000-character deterministic string, then run /pruner now. Briefly report the result.'
PROVIDER_EXTENSION="${PI_ANTIGRAVITY_EXTENSION:-}"
SOURCE_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="${2:-}"; shift 2 ;;
    --prompt) PROMPT="${2:-}"; shift 2 ;;
    --provider-extension) PROVIDER_EXTENSION="${2:-}"; shift 2 ;;
    --agent-dir) SOURCE_AGENT_DIR="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! "$MODEL" =~ ^google-antigravity/.+ ]]; then
  echo "error: --model must be a google-antigravity/<model> identifier" >&2
  exit 2
fi
if ! command -v pi >/dev/null 2>&1; then
  echo "error: pi is not on PATH; install or expose the pi CLI before running this smoke" >&2
  exit 2
fi
if [[ -z "$PROVIDER_EXTENSION" ]]; then
  echo "error: --provider-extension is required (or set PI_ANTIGRAVITY_EXTENSION)" >&2
  exit 2
fi
if [[ ! -f "$PROVIDER_EXTENSION" ]]; then
  echo "error: Antigravity provider extension does not exist: $PROVIDER_EXTENSION" >&2
  exit 2
fi
if [[ ! -f "$SOURCE_AGENT_DIR/auth.json" ]]; then
  echo "error: no authenticated auth.json at $SOURCE_AGENT_DIR; authenticate Antigravity first" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "$REPO_ROOT/index.ts" ]]; then
  echo "error: expected pi-condense index.ts under $REPO_ROOT" >&2
  exit 2
fi

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-condense-antigravity-smoke.XXXXXX")"
AGENT_DIR="$RUN_DIR/agent"
SESSION_DIR="$RUN_DIR/sessions"
cleanup() {
  # Never retain the copied credential, even when --keep preserves the session
  # artifact for operator inspection after a failed live request.
  rm -f "$AGENT_DIR/auth.json"
  if [[ "$KEEP" -eq 0 ]]; then
    rm -rf "$RUN_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$AGENT_DIR" "$SESSION_DIR"
cp "$SOURCE_AGENT_DIR/auth.json" "$AGENT_DIR/auth.json"
cat > "$AGENT_DIR/settings.json" <<EOF
{
  "contextPrune": {
    "enabled": true,
    "summarizerModel": "$MODEL",
    "summarizerThinking": "high",
    "pruneOn": "agent-message",
    "batchingMode": "turn",
    "minBatchChars": 1,
    "summarizerConcurrency": 1
  }
}
EOF

printf 'Running authenticated Antigravity smoke for %s...\n' "$MODEL"
printf 'Running isolated smoke session...\n'
set +e
PI_CODING_AGENT_DIR="$AGENT_DIR" pi \
  --approve \
  --no-extensions \
  --extension "$PROVIDER_EXTENSION" \
  --extension "$REPO_ROOT/index.ts" \
  --model "$MODEL" \
  --tools bash \
  --session-dir "$SESSION_DIR" \
  --name pi-condense-antigravity-smoke \
  --print "$PROMPT"
status=$?
set -e

session_file="$(find "$SESSION_DIR" -type f -name '*.jsonl' -print -quit || true)"
printf '\nSmoke command exit: %s\n' "$status"
printf 'Session artifact: %s\n' "${session_file:-none created}"
if [[ "$KEEP" -eq 1 ]]; then
  printf 'Retained run directory (without copied credentials): %s\n' "$RUN_DIR"
else
  printf '%s\n' 'Session artifact will be removed on exit; rerun with --keep to inspect it.'
fi
printf '%s\n' 'Manual acceptance criteria:'
printf '%s\n' '  1. Inspect the session artifact for context-prune-flush-metrics and context-prune-summary entries.'
printf '%s\n' '  2. Confirm the configured google-antigravity model produced the summary directly.'
printf '%s\n' '  3. If fallback occurred, compare its complete warning suffix with ANTIGRAVITY.md; record the observed provider/quota/network error.'
printf '%s\n' '  4. Only then mark the live-smoke task complete.'

# Keep artifacts whenever pi failed so the operator can inspect the real error.
if [[ "$status" -ne 0 ]]; then
  KEEP=1
  exit "$status"
fi
