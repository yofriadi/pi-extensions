#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/pi-condense-smoke-helper.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# Required-model validation must fail before any provider or credential access.
set +e
"$repo_root/scripts/smoke-antigravity.sh" --model not-antigravity > "$tmp/invalid-model.out" 2>&1
status=$?
set -e
test "$status" -eq 2
grep -F -- '--model must be a google-antigravity/<model> identifier' "$tmp/invalid-model.out" >/dev/null

# A fake pi proves the helper passes a narrowly-scoped no-shell invocation and
# removes the copied credential both on success and after a failed provider run.
mkdir -p "$tmp/bin" "$tmp/source-agent" "$tmp/provider"
printf '%s\n' '{"test":"credential"}' > "$tmp/source-agent/auth.json"
printf '%s\n' 'export default () => {}' > "$tmp/provider/index.ts"
cat > "$tmp/bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
session_dir=""
seen_no_approve=0
seen_no_builtin=0
seen_payload=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-dir) session_dir="$2"; shift 2 ;;
    --no-approve) seen_no_approve=1; shift ;;
    --no-builtin-tools) seen_no_builtin=1; shift ;;
    --tools) [[ "$2" == "pi_condense_smoke_payload" ]] && seen_payload=1; shift 2 ;;
    *) shift ;;
  esac
done
test "$seen_no_approve" -eq 1
test "$seen_no_builtin" -eq 1
test "$seen_payload" -eq 1
mkdir -p "$session_dir"
printf '%s\n' '{"type":"custom_message","customType":"context-prune-summary"}' > "$session_dir/smoke.jsonl"
if [[ "${FAKE_PI_FAIL:-0}" == 1 ]]; then exit 42; fi
FAKE_PI
chmod +x "$tmp/bin/pi"

run_helper() {
  PATH="$tmp/bin:$PATH" "$repo_root/scripts/smoke-antigravity.sh" \
    --model google-antigravity/gemini-3.7-flash \
    --provider-extension "$tmp/provider/index.ts" \
    --agent-dir "$tmp/source-agent" \
    "$@"
}

output="$(run_helper --keep)"
printf '%s\n' "$output" | grep -F 'Session artifact:' >/dev/null
run_dir="$(printf '%s\n' "$output" | sed -n 's/^Retained run directory (without copied credentials): //p')"
test -n "$run_dir"
test -f "$run_dir/sessions/smoke.jsonl"
test ! -e "$run_dir/agent/auth.json"
rm -rf "$run_dir"

set +e
failed_output="$(FAKE_PI_FAIL=1 run_helper 2>&1)"
status=$?
set -e
test "$status" -eq 42
failed_run_dir="$(printf '%s\n' "$failed_output" | sed -n 's/^Retained run directory (without copied credentials): //p')"
test -n "$failed_run_dir"
test -f "$failed_run_dir/sessions/smoke.jsonl"
test ! -e "$failed_run_dir/agent/auth.json"
rm -rf "$failed_run_dir"

printf '%s\n' 'smoke helper fail-closed, no-shell, and credential-retention checks passed'
