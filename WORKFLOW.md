# tmapdev → tmap promotion workflow

`tmapdev` (touchout.org/tmapdev) is where all new development happens and
gets tested live before anything reaches production. `tmap`
(touchout.org/tmap) only receives finished, tested work, promoted
explicitly when it's ready — never edited directly except via promotion
(see "Emergency hotfixes" below for the one exception). Promotion
preserves each `tmapdev` commit individually on `tmap`'s history via
`git rebase --onto` — not a squash — so `tmap`'s log reads as the real
incremental history of the work, not one big merge commit.

## One-time setup (already done, documented for reference)

- `tmap` added as a second remote in this clone:
  `git remote add tmap-prod https://github.com/touchout-org/tmap.git`
- A `last-promoted` tag marks the most recent commit already pushed to
  `tmap`. The two repos were manually synchronized as of 2026-08-01
  (`tmapdev`@`1f467e9` == `tmap`@`88a9286`) after the initial Postpass
  migration, which was promoted by hand (a direct file copy, not this
  workflow) under time pressure — everything from that point forward
  goes through `promote-to-tmap.sh`. Past history on both sides is left
  as-is; this workflow only governs promotions going forward.

## Dev-only commits

Any commit whose content must never reach `tmap` — the dev banner text
in `index.html`, storage-key namespacing, `buildId` prefix, `robots.txt`,
this file, `promote-to-tmap.sh` itself — gets `[tmapdev-only]` somewhere
in its commit message. The promotion script automatically drops these
during the rebase; they stay in `tmapdev`'s history forever, `tmap` never
sees them. (In practice this is mostly historical — the one-time
environment setup commit predates this convention and predates
`last-promoted`, so it's already permanently excluded by the tag itself.
The convention exists for whatever comes up next.)

## Promoting

```bash
./promote-to-tmap.sh            # preview: shows what would land on tmap's main, doesn't push
./promote-to-tmap.sh --push     # actually pushes it, and moves last-promoted forward
```

Always run the preview first and read the commit list before pushing.
Must be run from `tmapdev`'s own `main` branch with a clean working tree.

If the rebase hits a conflict — should be rare, only realistically
happens if `tmap` was edited directly outside this workflow — the script
says so and stops with the temp branch left in place. Resolve it (or
`git rebase --abort`) and re-run.

## Docs that live in both repos

`postpass-migration-spec.md` currently exists in both repos, kept in
sync by hand — a pattern from before this workflow existed, not one to
repeat. Going forward, planning/spec docs for new work should live in
`tmapdev` only while in progress and simply ride along with the normal
promotion once finished, exactly like any other file — no manual copying
between repos.

## Emergency hotfixes

If a production bug needs an immediate fix and there's genuinely no time
to develop it in `tmapdev` first: fix it in `tmapdev`, verify it there,
then promote right away (the script is fast — this doesn't mean waiting
days) rather than editing `tmap` directly. Editing `tmap` directly is
exactly the kind of divergence this workflow exists to prevent, and it's
what made the 2026-08-01 NVDA alert fix need two separate commits instead
of one promoted commit.
