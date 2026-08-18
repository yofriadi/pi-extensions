#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/pi-condense-release-helper.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/.agents/skills/release/scripts"
cp "$repo_root/.agents/skills/release/scripts/release.sh" "$tmp/.agents/skills/release/scripts/release.sh"
printf '%s\n' '{"version":"2.9.1"}' > "$tmp/package.json"

cd "$tmp"
git init --quiet
git config user.name test
git config user.email test@example.invalid
git add .
git commit --quiet -m initial
git tag -a v2.9.0 -m release
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
printf '%s\n' 'release helper SemVer-tag selection passed'
