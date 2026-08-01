#!/usr/bin/env bash
# Promotes tmapdev's tested work onto tmap's main branch, replaying each
# commit individually (not squashed) via cherry-pick onto a fresh branch
# based at tmap's current tip. See WORKFLOW.md for the full design and
# rationale.
#
# Usage:
#   ./promote-to-tmap.sh            preview only -- shows what would be
#                                    promoted, doesn't push anything
#   ./promote-to-tmap.sh --push     actually pushes the result to tmap's
#                                    main and moves the last-promoted tag
#
# Commits whose message contains "[tmapdev-only]" are automatically
# skipped -- they never reach tmap.

set -euo pipefail
cd "$(dirname "$0")"

TMAP_REMOTE="tmap-prod"
LAST_PROMOTED_TAG="last-promoted"
TEMP_BRANCH="promote-tmp"

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "Error: run this from tmapdev's main branch." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: uncommitted changes present. Commit or stash first." >&2
  exit 1
fi
if ! git rev-parse "$LAST_PROMOTED_TAG" >/dev/null 2>&1; then
  echo "Error: tag '$LAST_PROMOTED_TAG' not found -- see WORKFLOW.md setup." >&2
  exit 1
fi

echo "Fetching latest tmap..."
git fetch "$TMAP_REMOTE"

# Oldest-to-newest commit hashes since the last promotion.
mapfile -t ALL_COMMITS < <(git log --reverse --format=%H "${LAST_PROMOTED_TAG}..main")

if [ "${#ALL_COMMITS[@]}" -eq 0 ]; then
  echo "Nothing to promote -- main is already at $LAST_PROMOTED_TAG."
  exit 0
fi

TO_PROMOTE=()
for c in "${ALL_COMMITS[@]}"; do
  MSG=$(git log -1 --format=%s "$c")
  if [[ "$MSG" == *"[tmapdev-only]"* ]]; then
    echo "Skipping (tmapdev-only): $(git log -1 --oneline "$c")"
  else
    TO_PROMOTE+=("$c")
  fi
done
echo ""

if [ "${#TO_PROMOTE[@]}" -eq 0 ]; then
  echo "Everything since $LAST_PROMOTED_TAG was tmapdev-only -- nothing to promote."
  echo "Moving '$LAST_PROMOTED_TAG' forward to main anyway, so it's not re-checked next time."
  if [ "${1:-}" == "--push" ]; then
    git tag -f "$LAST_PROMOTED_TAG" main
    git push origin "$LAST_PROMOTED_TAG" --force
  else
    echo "(preview only -- re-run with --push to actually move the tag)"
  fi
  exit 0
fi

echo "Commits to promote (in order):"
for c in "${TO_PROMOTE[@]}"; do git log -1 --oneline "$c"; done
echo ""

git branch -f "$TEMP_BRANCH" "$TMAP_REMOTE/main" >/dev/null
git checkout -q "$TEMP_BRANCH"

if ! git cherry-pick "${TO_PROMOTE[@]}"; then
  echo "" >&2
  echo "Cherry-pick hit a conflict on branch '$TEMP_BRANCH'." >&2
  echo "Resolve it (edit conflicted files, git add, git cherry-pick --continue)" >&2
  echo "or run 'git cherry-pick --abort'. Once resolved, re-run this script." >&2
  exit 1
fi

echo "Commits that would land on tmap's main:"
git log --oneline "$TMAP_REMOTE/main..$TEMP_BRANCH"

if [ "${1:-}" != "--push" ]; then
  echo ""
  echo "Preview only -- not pushed. Re-run with --push to actually push this."
  git checkout -q main
  git branch -D "$TEMP_BRANCH" >/dev/null
  exit 0
fi

git push "$TMAP_REMOTE" "$TEMP_BRANCH:main"
git tag -f "$LAST_PROMOTED_TAG" main
git push origin "$LAST_PROMOTED_TAG" --force

git checkout -q main
git branch -D "$TEMP_BRANCH" >/dev/null

echo ""
echo "Promoted. Tag '$LAST_PROMOTED_TAG' moved to tmapdev's main ($(git rev-parse --short main)) and pushed."
