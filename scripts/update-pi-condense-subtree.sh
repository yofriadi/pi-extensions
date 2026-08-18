#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
prefix="packages/pi-condense"
remote_name="pi-condense-fork"
fork_url="git@github.com:yofriadi/pi-condense.git"
fork_ref="local/main"

cd "$repo_root"

# git-subtree only rejects tracked changes. Match that contract exactly: user
# untracked files are not a reason to block a safe package update.
if ! git diff-index --quiet HEAD -- || ! git diff-index --cached --quiet HEAD --; then
	echo "Refusing to update $prefix with tracked changes; commit or stash first." >&2
	exit 1
fi

if git remote get-url "$remote_name" >/dev/null 2>&1; then
	configured_url="$(git remote get-url "$remote_name")"
	case "$configured_url" in
		git@github.com:yofriadi/pi-condense.git|https://github.com/yofriadi/pi-condense.git|https://github.com/yofriadi/pi-condense|ssh://git@github.com/yofriadi/pi-condense.git|ssh://git@github.com/yofriadi/pi-condense) ;;
		*)
			echo "Refusing to update $prefix: $remote_name points at $configured_url, not yofriadi/pi-condense." >&2
			exit 1
			;;
	esac
else
	git remote add "$remote_name" "$fork_url"
fi

git fetch "$remote_name" "$fork_ref"
git rev-parse --verify "${remote_name}/${fork_ref}^{commit}" >/dev/null

git subtree pull \
	--prefix="$prefix" \
	"$remote_name" \
	"$fork_ref" \
	--squash \
	-m "Update pi-condense subtree from fork local/main"

package_dir="$repo_root/$prefix"
cd "$package_dir"

if grep -R -n --exclude-dir=node_modules --fixed-strings '@earendil-works/pi-ai/compat' src; then
	echo "G1 failed: legacy pi-ai/compat import or mock found." >&2
	exit 1
fi
if grep -R -n -E --exclude-dir=node_modules 'reasoningEffort[[:space:]]*:' src; then
	echo "G1 failed: provider-specific reasoningEffort option found." >&2
	exit 1
fi
bun run typecheck
bun test src/summarizer.test.ts src/summarizer-wiring.test.ts
bun test

echo "Updated $prefix from $remote_name/$fork_ref and passed G1–G4."
