#!/usr/bin/env bash
# Refresh packages/pi-auto-continue from the yofriadi/pi-auto-continue fork.
#
# Unlike the pi-condense / pi-session-recap scripts this is a faithful re-copy
# rather than a git-subtree merge: the vendored copy was created by copy, not by
# `subtree add`, so there is no subtree merge base to pull onto. The fork stays
# the source of truth; upstream changes are merged there first, then re-synced.
#
# To convert this to a real subtree later, on a clean worktree:
#   git subtree add --prefix=packages/pi-auto-continue \
#     https://github.com/yofriadi/pi-auto-continue.git main --squash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
prefix="packages/pi-auto-continue"
fork_url="https://github.com/yofriadi/pi-auto-continue.git"
fork_ref="main"

cd "$repo_root"

if [[ -n "$(git status --porcelain -- "$prefix")" ]]; then
	echo "error: $prefix has uncommitted changes; commit or stash them first." >&2
	exit 1
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-auto-continue-fork.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

git clone --quiet "$fork_url" "$tmp_dir/fork"
git -C "$tmp_dir/fork" checkout --quiet "$fork_ref"

# The manifest is adapted locally (workspace name, dev deps, pi metadata), so it
# is preserved across the re-copy. Stashed outside the tree because mktemp dirs
# can sit under TMPDIR, which rsync would then copy back in.
keep_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-auto-continue-keep.XXXXXX")
trap 'rm -rf "$tmp_dir" "$keep_dir"' EXIT
cp "$prefix/package.json" "$keep_dir/package.json"

rsync -a --delete \
	--exclude node_modules \
	--exclude .git \
	--exclude dist \
	--exclude package-lock.json \
	--exclude .synced-from \
	"$tmp_dir/fork/" "$prefix/"

cp "$keep_dir/package.json" "$prefix/package.json"

# Pin the exact fork commit this copy came from, outside the synced content so it
# survives --delete and shows up as a one-line diff whenever the fork moves.
git -C "$tmp_dir/fork" rev-parse HEAD > "$prefix/.synced-from"

echo "Synced $prefix from $fork_url@$fork_ref ($(git -C "$tmp_dir/fork" rev-parse --short HEAD))."
echo "Review with: git status --porcelain -- $prefix"
