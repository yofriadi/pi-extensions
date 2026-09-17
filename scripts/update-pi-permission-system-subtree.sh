#!/usr/bin/env bash
# Refresh packages/pi-permission-system from gotgenes/pi-packages.
#
# The upstream package lives below packages/pi-permission-system inside a larger
# monorepo, so the upstream root must never be subtree-pulled directly: split
# that directory into a temporary branch first, then pull from the split.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
prefix="packages/pi-permission-system"
upstream_url="https://github.com/gotgenes/pi-packages.git"
upstream_ref="main"
upstream_prefix="packages/pi-permission-system"

cd "$repo_root"
if [[ -n "$(git status --porcelain)" ]]; then
	echo "Refusing to update $prefix with a dirty worktree; commit or stash local changes first." >&2
	exit 1
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-permission-system-upstream.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

git clone --quiet "$upstream_url" "$tmp_dir/repo"
git -C "$tmp_dir/repo" subtree split \
	--quiet \
	--prefix="$upstream_prefix" \
	--branch=pi-permission-system-root \
	"$upstream_ref" >/dev/null

if ! git subtree pull \
	--prefix="$prefix" \
	"$tmp_dir/repo" \
	pi-permission-system-root \
	--squash \
	-m "Update gotgenes pi-permission-system subtree"; then
	echo "The subtree pull stopped, most likely on a conflict in files both" >&2
	echo "sides changed (expect $prefix/src/handlers/before-agent-start.ts and" >&2
	echo "$prefix/package.json)." >&2
	echo "Resolve within $prefix, 'git add' the resolved files, and conclude the" >&2
	echo "merge with 'git commit'; or discard it with 'git merge --abort' and" >&2
	echo "re-apply the local changes on top of the refreshed import." >&2
	exit 1
fi

echo "Updated $prefix from $upstream_url ($upstream_ref, $(git -C "$tmp_dir/repo" rev-parse --short HEAD))."
echo "Review and preserve the local changes: the fork rename and forkOf block in"
echo "package.json, the package-local tsconfig.json (must NOT inherit the repo"
echo "base), the dropped 'eslint .' from the lint script, and the custom-prompt"
echo "skip in src/handlers/before-agent-start.ts."
