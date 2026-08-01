#!/usr/bin/env bash
# Promotes tmapdev's tested work onto tmap's main branch, replaying each
# commit individually (not squashed) via git rebase --onto. See
# WORKFLOW.md for the full design and rationale.
#
# Usage:
#   ./promote-to-tmap.sh            preview only -- shows what would be
#                                    promoted, doesn't push anything
#   ./promote-to-tmap.sh --push     actually pushes the result to tmap's
#                                    main and moves the last-promoted tag
#
# Commits whose message contains "[tmapdev-only]" are automatically
# dropped during the rebase -- they never reach tmap.

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

echo ""
echo "tmapdev commits since last promotion:"
git log --oneline "${LAST_PROMOTED_TAG}..main"
echo ""

git branch -f "$TEMP_BRANCH" main >/dev/null

if ! GIT_SEQUENCE_EDITOR="sed -i '/\[tmapdev-only\]/d'" \
  git rebase --onto "$TMAP_REMOTE/main" "$LAST_PROMOTED_TAG" "$TEMP_BRANCH"; then
  echo "" >&2
  echo "Rebase hit a conflict on branch '$TEMP_BRANCH'." >&2
  echo "Resolve it (edit conflicted files, git add, git rebase --continue)" >&2
  echo "or run 'git rebase --abort'. Once resolved, re-run this script." >&2
  exit 1
fi

echo "Commits that would land on tmap's main:"
git log --oneline "$TMAP_REMOTE/main..$TEMP_BRANCH"

if [ "${1:-}" != "--push" ]; then
  echo ""
  echo "Preview only -- not pushed. Re-run with --push to actually push this."
  git checkout main >/dev/null
  git branch -D "$TEMP_BRANCH" >/dev/null
  exit 0
fi

git push "$TMAP_REMOTE" "$TEMP_BRANCH:main"
NEW_TIP=$(git rev-parse "$TEMP_BRANCH")
git tag -f "$LAST_PROMOTED_TAG" "$NEW_TIP"
git push origin "$LAST_PROMOTED_TAG" --force

git checkout main >/dev/null
git branch -D "$TEMP_BRANCH" >/dev/null

echo ""
echo "Promoted through $NEW_TIP. Tag '$LAST_PROMOTED_TAG' updated and pushed."
