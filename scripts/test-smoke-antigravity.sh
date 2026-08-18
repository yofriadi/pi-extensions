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

# A fake pi lets us verify session isolation/credential cleanup without making a
# network request or claiming a genuine Antigravity result.
mkdir -p "$tmp/bin" "$tmp/source-agent" "$tmp/provider"
printf '%s\n' '{"test":"credential"}' > "$tmp/source-agent/auth.json"
printf '%s\n' 'export default () => {}' > "$tmp/provider/index.ts"
cat > "$tmp/bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
session_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-dir) session_dir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$session_dir"
printf '%s\n' '{"type":"custom_message","customType":"context-prune-summary"}' > "$session_dir/smoke.jsonl"
FAKE_PI
chmod +x "$tmp/bin/pi"

output="$(PATH="$tmp/bin:$PATH" "$repo_root/scripts/smoke-antigravity.sh" \
  --model google-antigravity/gemini-3.7-flash \
  --provider-extension "$tmp/provider/index.ts" \
  --agent-dir "$tmp/source-agent" \
  --keep)"
printf '%s\n' "$output" | grep -F 'Session artifact:' >/dev/null
run_dir="$(printf '%s\n' "$output" | sed -n 's/^Retained run directory (without copied credentials): //p')"
test -n "$run_dir"
test -f "$run_dir/sessions/smoke.jsonl"
test ! -e "$run_dir/agent/auth.json"
rm -rf "$run_dir"
printf '%s\n' 'smoke helper fail-closed/isolation checks passed'
