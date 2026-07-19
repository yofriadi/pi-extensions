#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
prefix="packages/pi-session-recap"
upstream_url="https://github.com/tmustier/pi-extensions.git"
upstream_ref="main"

cd "$repo_root"
if [[ -n "$(git status --porcelain)" ]]; then
	echo "Refusing to update $prefix with a dirty worktree; commit or stash local changes first." >&2
	exit 1
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-session-recap-upstream.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

git clone --quiet "$upstream_url" "$tmp_dir/repo"
git -C "$tmp_dir/repo" subtree split \
	--prefix=session-recap \
	--branch=session-recap-root \
	"$upstream_ref" >/dev/null

git subtree pull \
	--prefix="$prefix" \
	"$tmp_dir/repo" \
	session-recap-root \
	--squash \
	-m "Update tmustier session-recap subtree"

echo "Updated $prefix from $upstream_url ($upstream_ref)."
echo "Review and resolve any conflicts while preserving the custom-provider and sessionRecap.model changes."
