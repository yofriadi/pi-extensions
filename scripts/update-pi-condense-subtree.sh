#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
prefix="packages/pi-condense"
upstream_url="https://github.com/jjuraszek/pi-condense.git"
upstream_ref="main"

cd "$repo_root"
if [[ -n "$(git status --porcelain)" ]]; then
	echo "Refusing to update $prefix with a dirty worktree; commit or stash local changes first." >&2
	exit 1
fi

git subtree pull \
	--prefix="$prefix" \
	"$upstream_url" \
	"$upstream_ref" \
	--squash \
	-m "Update jjuraszek pi-condense subtree"

echo "Updated $prefix from $upstream_url ($upstream_ref)."
