#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/pi-condense-release-helper.XXXXXX")"
remote="$tmp.remote.git"
bin="$tmp.bin"
trap 'rm -rf "$tmp" "$remote" "$bin"' EXIT

mkdir -p "$tmp/.agents/skills/release/scripts" "$bin"
cp "$repo_root/.agents/skills/release/scripts/release.sh" "$tmp/.agents/skills/release/scripts/release.sh"
printf '%s\n' '{"version":"2.9.1"}' > "$tmp/package.json"
git init --bare --quiet "$remote"

cd "$tmp"
git init --quiet
git config user.name test
git config user.email test@example.invalid
git branch -M local/main
git remote add origin "$remote"
git add .
git commit --quiet -m initial
git tag -a v2.9.0 -m release
git push --quiet origin local/main refs/tags/v2.9.0
echo baseline >> note
git add note
git commit --quiet -m 'feat: local layer'
git tag -a subtree-v2.9.0+local -m baseline
echo hardening >> note
git add note
git commit --quiet -m 'fix: automation'

output="$(bash .agents/skills/release/scripts/release.sh propose)"
printf '%s\n' "$output" | grep -F 'Commits since v2.9.0 (2):' >/dev/null
printf '%s\n' "$output" | grep -F 'feat: local layer' >/dev/null
printf '%s\n' "$output" | grep -F 'fix: automation' >/dev/null

# `current` must reject a malformed package version before it reaches release
# mutation or CI-tag creation.
printf '%s\n' '{"version":"2.9.1-beta.1"}' > package.json
set +e
bad_version="$(bash .agents/skills/release/scripts/release.sh --skip-tests current 2>&1)"
status=$?
set -e
test "$status" -ne 0
printf '%s\n' "$bad_version" | grep -F 'version must be plain X.Y.Z' >/dev/null
printf '%s\n' '{"version":"2.9.1"}' > package.json

# A tag added only on origin is rejected before the script creates a release
# commit or local tag.
git tag -a v2.9.1 -m remote-only
git push --quiet origin refs/tags/v2.9.1
git tag -d v2.9.1 >/dev/null
set +e
remote_collision="$(bash .agents/skills/release/scripts/release.sh --skip-tests current 2>&1)"
status=$?
set -e
test "$status" -ne 0
printf '%s\n' "$remote_collision" | grep -F 'remote tag v2.9.1 already exists on origin' >/dev/null
! git rev-parse -q --verify refs/tags/v2.9.1 >/dev/null

# A valid release pushes branch and tag in one atomic ref transaction. Stub
# verification clients so the test never polls external services.
cat > "$bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *'run list'*) printf '1\n' ;;
  *'run watch'*) exit 0 ;;
  *) exit 0 ;;
esac
EOF
cat > "$bin/npm" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "view" ]]; then printf '2.9.2\n'; fi
EOF
cat > "$bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$bin/gh" "$bin/npm" "$bin/curl"
printf '%s\n' '{"version":"2.9.2"}' > package.json
git add package.json
git commit --quiet -m 'Release 2.9.2'
PATH="$bin:$PATH" bash .agents/skills/release/scripts/release.sh --skip-tests current >/dev/null
test "$(git rev-parse refs/tags/v2.9.2)" = "$(git --git-dir="$remote" rev-parse refs/tags/v2.9.2)"
test "$(git rev-parse local/main)" = "$(git --git-dir="$remote" rev-parse refs/heads/local/main)"

printf '%s\n' 'release helper tag selection, version, remote collision, and atomic push passed'
