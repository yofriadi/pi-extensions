#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
prefix="packages/pi-condense"
remote_name="pi-condense-fork"
fork_url="git@github.com:yofriadi/pi-condense.git"
fork_ref="local/main"

fail() {
	echo "error: $*" >&2
	exit 1
}

cd "$repo_root"

# Work on a detached candidate so a failed subtree pull, lock refresh, or gate
# leaves the caller branch exactly where it started. Untracked user files do
# not affect git-subtree and are deliberately allowed.
if ! git diff-index --quiet HEAD -- || ! git diff-index --cached --quiet HEAD --; then
	fail "refusing to update $prefix with tracked changes; commit or stash first"
fi

if git remote get-url "$remote_name" >/dev/null 2>&1; then
	configured_url="$(git remote get-url "$remote_name")"
	case "$configured_url" in
		git@github.com:yofriadi/pi-condense.git|https://github.com/yofriadi/pi-condense.git|https://github.com/yofriadi/pi-condense|ssh://git@github.com/yofriadi/pi-condense.git|ssh://git@github.com/yofriadi/pi-condense) ;;
		*) fail "$remote_name points at $configured_url, not yofriadi/pi-condense" ;;
	esac
else
	git remote add "$remote_name" "$fork_url"
fi

git fetch "$remote_name" "$fork_ref"
git rev-parse --verify "${remote_name}/${fork_ref}^{commit}" >/dev/null

start_head="$(git rev-parse HEAD)"
candidate="$(mktemp -d "${TMPDIR:-/tmp}/pi-condense-subtree-update.XXXXXX")"
worktree_added=0
cleanup() {
	if [[ "$worktree_added" -eq 1 ]]; then
		git worktree remove --force "$candidate" >/dev/null 2>&1 || true
	fi
	rm -rf "$candidate"
}
trap cleanup EXIT

git worktree add --detach "$candidate" "$start_head" >/dev/null
worktree_added=1

(
	cd "$candidate"
	git subtree pull \
		--prefix="$prefix" \
		"$remote_name" \
		"$fork_ref" \
		--squash \
		-m "Update pi-condense subtree from fork local/main"
)

# The root lockfile belongs to the monorepo, not the fork subtree. Regenerate
# only when the consumed package manifest changed, and validate it before the
# candidate can advance the caller branch.
if ! git diff --quiet "${start_head}:${prefix}/package.json" "${candidate}:${prefix}/package.json"; then
	expected_pnpm="$(node -p "require('./package.json').packageManager.split('@')[1]")"
	actual_pnpm="$(pnpm --version)"
	[[ "$actual_pnpm" == "$expected_pnpm" ]] || fail "pnpm $expected_pnpm is required; found $actual_pnpm"
	(
		cd "$candidate"
		pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts
		git add pnpm-lock.yaml
		if ! git diff --cached --quiet; then
			git commit -m "chore: refresh workspace lockfile after pi-condense update"
		fi
	)
fi

(
	cd "$candidate"
	pnpm install --frozen-lockfile --ignore-scripts
	package_dir="$candidate/$prefix"
	cd "$package_dir"
	if grep -R -n --exclude-dir=node_modules --fixed-strings '@earendil-works/pi-ai/compat' src; then
		fail "G1 failed: legacy pi-ai/compat import or mock found"
	fi
	if grep -R -n -E --exclude-dir=node_modules 'reasoningEffort[[:space:]]*:' src; then
		fail "G1 failed: provider-specific reasoningEffort option found"
	fi
	bun run typecheck
	bun test src/summarizer.test.ts src/summarizer-wiring.test.ts
	bun test
	cd "$candidate"
	pnpm run check
)

candidate_head="$(git -C "$candidate" rev-parse HEAD)"
git -C "$candidate" diff-index --quiet HEAD --
git -C "$candidate" diff --cached --quiet

# The candidate started at HEAD, so a fast-forward is the only permitted caller
# mutation. Any failed command above exits before this point and cleanup removes
# the candidate without touching the caller branch.
if [[ "$candidate_head" != "$start_head" ]]; then
	git merge --ff-only "$candidate_head"
fi

echo "Updated $prefix from $remote_name/$fork_ref and passed lock validation plus G1–G4."
