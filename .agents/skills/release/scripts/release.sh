#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Release helper for this fork.
# The CONFIG block below identifies the package and repository; keep the
# remaining release mechanics stable unless their behavior needs to change.
#
# Tag scheme: v<major>.<minor>.<patch>. package.json version mirrors the tag
# without the leading "v". This script assigns the version and pushes the tag;
# pushing a v* tag triggers .github/workflows/release.yml, which runs the tests
# and publishes to npm (OIDC trusted publishing + provenance). It never runs
# `npm publish` itself.
# ============================================================================

# ---- CONFIG (per-repo; the ONLY block that differs between pi-* repos) ------
PACKAGE_NAME="@yofriadi/pi-condense"
REPO_SLUG="yofriadi/pi-condense"
RELEASE_BRANCH="local/main"
LEGACY_PACKAGE_NAMES="pi-condense,pi-context-prune"  # migrate versioned unscoped npm pins
TEST_CMD="bun run typecheck && bun test src/"
# ----------------------------------------------------------------------------

RELEASE_WORKFLOW="release.yml"
PIDEV_URL="https://pi.dev/packages/${PACKAGE_NAME}"

usage() {
  cat <<EOF
Usage:
  release.sh <command> [flags]

Commands:
  propose                 Show commits since the last tag and a heuristic bump
                          level. Advisory only; no changes. The user picks.
  current                 Tag the version already in package.json (no bump).
  patch|minor|major       Bump package.json, commit "Release <version>", run
                          ${TEST_CMD}, tag, push ${RELEASE_BRANCH} + tag.
  verify [X.Y.Z]          Monitor the release workflow, then poll npm and the
                          pi.dev catalog for the version (default: package.json).
  sync-presets            Report pins of ${PACKAGE_NAME} in pi settings.json
                          files under ~/.pi and this repo's parent tree.

Flags:
  --dry-run               (bump commands) Print the plan and exit; no changes.
  --skip-tests            (bump commands) Skip the local ${TEST_CMD} pre-flight.
  --apply                 (sync-presets)  Rewrite same-form npm pins to the new
                          version in place. Default is report-only.
  -h, --help              This help.

Examples:
  release.sh propose
  release.sh minor
  release.sh --dry-run minor
  release.sh verify
  release.sh sync-presets
  release.sh sync-presets --apply

Pushing the tag triggers the npm publish workflow; this script never publishes.
EOF
}

DRY_RUN=0
SKIP_TESTS=0
APPLY=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    DRY_RUN=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --apply)      APPLY=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            ARGS+=("$1"); shift ;;
  esac
done

CMD="${ARGS[0]:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../" && pwd)"
cd "$REPO_ROOT"

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

current_version() {
  node -p "require('./package.json').version"
}

assert_plain_version() {
  local version="$1"
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: package.json version must be plain X.Y.Z for a release (got $version)" >&2
    exit 1
  fi
}

compute_next_version() {
  local cur="$1" mode="$2"
  node -e '
    const [cur, mode] = process.argv.slice(1);
    if (mode === "current") { process.stdout.write(cur); process.exit(0); }
    const m = cur.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) { console.error(`current version ${cur} is not semver`); process.exit(1); }
    let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mode === "major") { maj += 1; min = 0; pat = 0; }
    else if (mode === "minor") { min += 1; pat = 0; }
    else if (mode === "patch") { pat += 1; }
    process.stdout.write(`${maj}.${min}.${pat}`);
  ' "$cur" "$mode"
}

require_clean_tree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "error: working tree is not clean; commit or stash before releasing" >&2
    git status --short >&2 || true
    exit 1
  fi
}

require_release_branch() {
  local branch
  branch="$(git branch --show-current)"
  if [[ "$branch" != "$RELEASE_BRANCH" ]]; then
    echo "error: releases run from ${RELEASE_BRANCH} (on '$branch')" >&2
    exit 1
  fi
}

nearest_release_tag() {
  # Baseline tags such as subtree-v2.9.0+local are intentionally excluded:
  # only a tag that can trigger release.yml is a release comparison point.
  local tag distance best_tag="" best_distance=""
  while IFS= read -r tag; do
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    distance="$(git rev-list --count "${tag}..HEAD")"
    if [[ -z "$best_distance" || "$distance" -lt "$best_distance" ]]; then
      best_tag="$tag"
      best_distance="$distance"
    fi
  done < <(git for-each-ref --merged=HEAD --format='%(refname:strip=2)' refs/tags)
  printf '%s' "$best_tag"
}

# ---- propose ---------------------------------------------------------------
cmd_propose() {
  local last range log count suggestion
  last="$(nearest_release_tag)"
  range="${last:+${last}..HEAD}"
  log="$(git --no-pager log ${range:-} --oneline)"
  count="$(printf '%s\n' "$log" | grep -c . || true)"

  if [[ -z "$log" ]]; then
    echo "No commits since ${last:-repo start}. Nothing to release."
    return 0
  fi

  if printf '%s\n' "$log" | grep -qiE 'breaking|!:|major:'; then
    suggestion="major"
  elif printf '%s\n' "$log" | grep -qiE '(feat|feature|add|new)[:( ]'; then
    suggestion="minor"
  else
    suggestion="patch"
  fi

  echo "Commits since ${last:-repo start} (${count}):"
  printf '%s\n' "$log" | sed 's/^/  /'
  echo
  echo "Heuristic suggestion: ${suggestion}"
  echo "  major = breaking change / rename / config-schema break"
  echo "  minor = new agent, skill, extension, or feature"
  echo "  patch = fixes, prose, internal changes"
  echo
  echo "This is advisory. Confirm the level with the user, then run:"
  echo "  bash .agents/skills/release/scripts/release.sh <level>"
}

# ---- release (current|patch|minor|major) -----------------------------------
cmd_release() {
  local mode="$1" old new tag sha
  old="$(current_version)"
  assert_plain_version "$old"
  new="$(compute_next_version "$old" "$mode")"
  tag="v${new}"
  if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
    echo "error: local tag ${tag} already exists" >&2
    exit 1
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Dry run:"
    echo "  mode:            $mode"
    echo "  current version: $old"
    echo "  new version:     $new"
    echo "  new tag:         $tag"
    echo "  branch:          $(git branch --show-current)"
    [[ -n "$(git status --porcelain)" ]] && echo "  note: tree not clean; a real release stops until clean."
    [[ "$mode" != "current" ]] && echo "  would set package.json to $new and commit 'Release $new'"
    [[ "$SKIP_TESTS" -eq 0 ]] && echo "  would run ${TEST_CMD} before tagging"
    echo "  would create annotated tag $tag and push ${RELEASE_BRANCH} + tag to origin"
    echo "  then monitor the workflow and verify npm + pi.dev"
    exit 0
  fi

  require_release_branch
  require_clean_tree
  if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
    echo "error: remote tag ${tag} already exists on origin" >&2
    exit 1
  fi

  if [[ "$mode" != "current" ]]; then
    node -e '
      const fs = require("fs");
      const p = require("./package.json");
      p.version = process.argv[1];
      fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
    ' "$new"
    run git add package.json
    run git commit -m "Release ${new}"
  fi

  if [[ "$SKIP_TESTS" -eq 0 ]]; then
    echo "+ ${TEST_CMD}"
    eval "$TEST_CMD"
  fi

  run git tag -a "$tag" -m "Release ${new}"
  run git push --atomic origin "$RELEASE_BRANCH" "refs/tags/$tag"

  sha="$(git rev-parse HEAD)"
  cat <<EOF

Tag pushed. .github/workflows/${RELEASE_WORKFLOW} now publishes to npm.
  old version: $old
  new version: $new
  tag:         $tag
  commit:      $sha
  actions:     https://github.com/${REPO_SLUG}/actions

Monitoring the workflow and verifying the publish...
EOF
  cmd_verify "$new"
}

# ---- verify ----------------------------------------------------------------
cmd_verify() {
  local version="${1:-$(current_version)}"

  echo
  echo "== CI: release workflow (tag v${version}) =="
  if command -v gh >/dev/null 2>&1; then
    # Pin to THIS tag's run (headBranch == the tag) and poll until it registers.
    # A bare --limit=1 races: it can match a prior release run that is already
    # green and report success while this tag's run has not appeared yet.
    local run_id=""
    for _ in $(seq 1 12); do
      run_id="$(gh run list --workflow="${RELEASE_WORKFLOW}" --branch="v${version}" --limit=1 \
        --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
      [[ -n "$run_id" ]] && break
      sleep 5
    done
    if [[ -n "$run_id" ]]; then
      gh run watch "$run_id" --exit-status || {
        echo "release workflow failed; inspect with: gh run view $run_id --log-failed" >&2
        return 1
      }
    else
      echo "no run found for tag v${version} yet; check https://github.com/${REPO_SLUG}/actions"
    fi
  else
    echo "gh not installed; watch https://github.com/${REPO_SLUG}/actions manually"
  fi

  echo
  echo "== npm: ${PACKAGE_NAME}@${version} =="
  local seen=""
  for _ in $(seq 1 12); do
    seen="$(npm view "${PACKAGE_NAME}@${version}" version 2>/dev/null || true)"
    [[ -n "$seen" ]] && break
    sleep 10
  done
  if [[ "$seen" == "$version" ]]; then
    echo "npm: ${PACKAGE_NAME}@${version} is live"
  else
    echo "npm: ${PACKAGE_NAME}@${version} not visible yet (registry lag or failed publish)" >&2
    return 1
  fi

  echo
  echo "== pi.dev catalog (best-effort) =="
  local page=""
  page="$(curl -fsSL "$PIDEV_URL" 2>/dev/null || true)"
  if [[ -z "$page" ]]; then
    echo "pi.dev: not reachable / not indexed yet (crawl lag, expected)"
  elif printf '%s' "$page" | grep -q "$version"; then
    echo "pi.dev: ${PACKAGE_NAME} shows ${version}"
  else
    echo "pi.dev: ${PACKAGE_NAME} present but ${version} not indexed yet (crawl lag, expected)"
  fi
}

# ---- sync-presets ----------------------------------------------------------
cmd_sync_presets() {
  local version files=()
  version="$(current_version)"

  local f
  while IFS= read -r f; do files+=("$f"); done < <(
    {
      if command -v fd >/dev/null 2>&1; then
        fd -Hg settings.json "$HOME/.pi" 2>/dev/null || true
        fd -Hg settings.json "$(dirname "$REPO_ROOT")" 2>/dev/null | grep -F '/.pi/' || true
      else
        find "$HOME/.pi" -name settings.json 2>/dev/null || true
        find "$(dirname "$REPO_ROOT")" -maxdepth 4 -name settings.json 2>/dev/null | grep -F '/.pi/' || true
      fi
    } | sort -u
  )

  if [[ ${#files[@]} -eq 0 ]]; then
    echo "no pi settings.json files found under ~/.pi or $(dirname "$REPO_ROOT")"
    return 0
  fi

  echo "Scanning ${#files[@]} settings.json for ${PACKAGE_NAME} pins (target: ${version})"
  echo "  apply mode: $([[ "$APPLY" -eq 1 ]] && echo "ON (rewriting same-form npm pins)" || echo "off (report only)")"
  echo

  APPLY="$APPLY" PACKAGE_NAME="$PACKAGE_NAME" LEGACY_PACKAGE_NAMES="$LEGACY_PACKAGE_NAMES" \
  REPO_SLUG="$REPO_SLUG" VERSION="$version" \
  node -e '
    const fs = require("fs");
    const { APPLY, PACKAGE_NAME, LEGACY_PACKAGE_NAMES, REPO_SLUG, VERSION } = process.env;
    const files = process.argv.slice(1);
    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const scopedNpmPin = new RegExp(`^npm:${escapeRegExp(PACKAGE_NAME)}@`);
    const gitPin = new RegExp(`^git:github\\.com/${escapeRegExp(REPO_SLUG)}@`);
    const legacyPackageNames = LEGACY_PACKAGE_NAMES.split(",").filter(Boolean);
    const legacyNpmPins = legacyPackageNames.map((name) => new RegExp(`^npm:${escapeRegExp(name)}@`));
    const legacyGitPin = new RegExp(`^git:github\\.com/[^/]+/(${legacyPackageNames.map(escapeRegExp).join("|")})@`);
    let touched = 0;
    for (const file of files) {
      let raw, data;
      try { raw = fs.readFileSync(file, "utf8"); data = JSON.parse(raw); }
      catch (e) { console.log(`  ${file}\\n    skip: not parseable JSON (${e.message})`); continue; }
      const pkgs = Array.isArray(data.packages) ? data.packages : [];
      const notes = [];
      let changed = false;
      pkgs.forEach((entry, i) => {
        if (typeof entry !== "string") return;
        const want = `npm:${PACKAGE_NAME}@${VERSION}`;
        if (scopedNpmPin.test(entry)) {
          if (entry === want) { notes.push(`already ${want}`); return; }
          notes.push(`bump ${entry} -> ${want}`);
          if (APPLY === "1") { pkgs[i] = want; changed = true; }
        } else if (legacyNpmPins.some((pattern) => pattern.test(entry))) {
          notes.push(`migrate ${entry} -> ${want}`);
          if (APPLY === "1") { pkgs[i] = want; changed = true; }
        } else if (gitPin.test(entry)) {
          notes.push(`git pin ${entry}: migrate to ${want} (manual)`);
        } else if (legacyGitPin.test(entry)) {
          notes.push(`legacy git pin ${entry}: migrate to ${want} (manual)`);
        }
      });
      if (notes.length === 0) continue;
      console.log(`  ${file}`);
      for (const n of notes) console.log(`    ${n}`);
      if (changed) {
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
        console.log(`    written.`);
        touched++;
      }
    }
    if (APPLY === "1") console.log(`\napplied to ${touched} file(s).`);
    else console.log(`\nreport only. Re-run with --apply to rewrite same-form npm pins.`);
  ' "${files[@]}"
}

case "$CMD" in
  propose)                   cmd_propose ;;
  current|patch|minor|major) cmd_release "$CMD" ;;
  verify)                    cmd_verify "${ARGS[1]:-}" ;;
  sync-presets)              cmd_sync_presets ;;
  "")                        usage; exit 1 ;;
  *)
    echo "error: unknown command '$CMD'" >&2
    usage >&2
    exit 1 ;;
esac
