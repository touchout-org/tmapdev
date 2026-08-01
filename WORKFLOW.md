# tmapdev → tmap promotion workflow

`tmapdev` (touchout.org/tmapdev) is where all new development happens and
gets tested live before anything reaches production. `tmap`
(touchout.org/tmap) only receives finished, tested work, promoted
explicitly when it's ready — never edited directly except via promotion
(see "Emergency hotfixes" below for the one exception). Promotion
preserves each `tmapdev` commit individually on `tmap`'s history via
`promote-to-tmap.sh` (cherry-pick onto a fresh branch based at `tmap`'s
tip, then push) — not a squash — so `tmap`'s log reads as the real
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

## No dev-mode banners or UI alerts (important, 2026-08-01)

`tmapdev`'s UI must behave and look **exactly** like `tmap`'s — no
"you're on the dev site" banner, no visible or screen-reader-announced
indication of which environment is being used. Josh's call: it's the
tester's own responsibility to track which site they're on, and any
dev-site indicator risks the dev environment behaving subtly differently
from production, which defeats the point of testing there first. This is
why the `dev-build-banner` element and its wiring were removed entirely
(commits `4391e40`/`a8f78b5`) rather than just left hidden-by-default —
don't reintroduce anything like it. This applies specifically to visible
UI/announced content; it does *not* cover invisible safeguards that
don't affect what a user sees or hears, like `robots.txt`/the `noindex`
meta tag (search-engine-only) or `IS_DEV_BUILD`'s storage-key
namespacing and `buildId` prefix (prevents real data-collision bugs
between the two sites, never rendered or announced to anyone) — those
stay. The `dev-cache-banner`/`dev-emulator-banner` alerts also stay, for
a different reason: they're not "which site am I on" signals, they warn
that a *local-only testing flag* (`USE_LOCAL_TEST_DATA_CACHE`/
`USE_FIREBASE_EMULATORS`) was accidentally left on before a deploy — a
real mistake worth catching loudly, unrelated to dev-vs-prod identity.

## Dev-only commits

Any commit whose content must never reach `tmap` — storage-key
namespacing, `buildId` prefix, `robots.txt`, this file,
`promote-to-tmap.sh` itself, anything else tied to `tmapdev`'s own
identity as a site — gets `[tmapdev-only]` somewhere in its commit
message. The promotion script automatically skips these; they stay in
`tmapdev`'s history forever, `tmap` never sees them. (The original
one-time environment setup commit predates this convention and predates
`last-promoted`, so it's already permanently excluded by the tag itself.
The convention exists for whatever comes up next.)

## Promoting

```bash
./promote-to-tmap.sh            # preview: shows what would land on tmap's main, doesn't push
./promote-to-tmap.sh --push     # actually pushes it, and moves last-promoted forward
```

Always run the preview first and read the commit list before pushing.
Must be run from `tmapdev`'s own `main` branch with a clean working tree.

If the cherry-pick hits a conflict — should be rare, only realistically
happens if `tmap` was edited directly outside this workflow — the script
says so and stops with the temp branch left in place. Resolve it (or
`git cherry-pick --abort`) and re-run.

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
