# Postpass migration — scope and work plan

Status: **spec only, not yet implemented.** This document exists to scope
the work and get agreement on the design before any code changes land.

## 1. Why

Two independent sources of evidence, gathered over the last two days,
point the same direction:

- **Real production data** (`overpassLogs` Firestore collection, ~49
  queries logged over its first day): a **29.2% failure rate in the last
  24h**, all timeouts, plus a p95 latency of **11.6s even among successful
  queries**. See `admin/overpass-stats/`.
- **Direct benchmark data** (`admin/benchmark/results.csv`, 5 runs across
  ~40 hours, 4 anchor locations, both services queried identically):
  Postpass has needed **zero retries in 19 checks** and averaged **723ms**;
  Overpass has needed a retry in **4 of 19 (21%)**, averaged **4,014ms**,
  and produced several genuine 504 timeouts, with the two most recent runs
  showing more of them clustered together than the earlier runs.

Postpass (`postpass.geofabrik.de`), a free public PostGIS-backed service
also run by Geofabrik, has been the more reliable and consistently faster
option in every test to date. This document scopes replacing Overpass
with Postpass as TMAP's live street-data source.

## 2. Current architecture (what this touches)

All of this lives in `app.js`. There is exactly **one** function that
talks to Overpass: `fetchWays(bbox, searchQuery, country)` (around line
2992 as of this writing). It has two callers:

- `createNewAnchor()` — a fresh search (new anchor).
- `loadMapRecord()` — restoring a Map History or Saved Maps entry, or (as
  of the ways-cache feature shipped 2026-07-29) falling back to a live
  fetch when the local IndexedDB ways-cache misses.

Because both callers funnel through `fetchWays()`, **migrating the data
source inside that one function affects both uniformly** — unlike the
ways-cache feature, there's no reason to special-case fresh searches vs.
reloads here; both should use whichever data source is authoritative.

`fetchWays()`'s current shape:

1. Check the dev-only local test-data cache (`loadLocalTestData`) — early
   return, no network call. **Untouched by this migration** — those
   fixture files store Overpass-shaped ways and will keep doing so; only
   the *live* fetch branch changes.
2. Build the Overpass QL query, POST it, get back `{elements: [{type,
   id, tags, geometry: [{lat, lon}, ...]}, ...]}`.
3. Classify failures into `OsmFetchError` kinds: `network`,
   `rate-limited`, `server-error`, `timeout` (including the Overpass-
   specific "200 OK with a `remark` field" soft-failure case).
4. Fire an analytics log row (`logOverpassQuery`) with elapsed time and
   error type, win or lose.
5. Return `data.elements` to the caller, which calls `processWays()`
   (tags each way with a tier via `HIGHWAY_TIERS`, keyed off
   `way.tags.highway`) and eventually `showAnchor()`.

Everything downstream — rendering, Auto Simplification, the Street
Abbreviation Key, hidden-street-name toggling, label assignment
(`assignBrailleLabels`), SVG export, the ways-cache — consumes
`lastWays`/`lastRawWays` in this same shape and is **agnostic to where the
ways came from**, as long as the shape matches.

## 3. What we know about Postpass

Verified directly against the live service this session (not just
documentation):

- **Endpoint:** `POST https://postpass.geofabrik.de/api/interpreter`,
  body `data=<SQL>` url-encoded — same POST shape as Overpass, so the
  `fetch()` call structure barely changes.
- **Query language:** SQL against a PostGIS schema, not Overpass QL.
  Verified working equivalent of today's query:
  ```sql
  SELECT osm_id, geom, tags FROM postpass_line
  WHERE geom && ST_MakeEnvelope(west, south, east, north, 4326)
    AND tags?'highway' AND tags?'name'
  ```
  (Note the bbox argument order to `ST_MakeEnvelope` is west/south/east/
  north — different from Overpass QL's south/west/north/east. Easy to get
  backwards; the benchmark script already has this right in
  `admin/benchmark/overpass-vs-postpass.mjs` and should be the reference.)
- **Response shape:** GeoJSON `FeatureCollection`. Each way comes back as:
  ```json
  {
    "type": "Feature",
    "geometry": { "type": "MultiLineString", "coordinates": [[[lon, lat], ...]] },
    "properties": { "osm_id": 619535759, "tags": { "highway": "residential", "name": "Jackson Street", ... } }
  }
  ```
  Tags are the identical OSM tag dictionary Overpass returns — no
  retagging needed, just repackaging.
- **CORS:** confirmed wide open (`Access-Control-Allow-Origin: *`) via a
  direct cross-origin test — safe to call straight from the browser, no
  backend proxy needed, unlike the Geofabrik *paid* Overpass tier we
  looked at earlier (different product, different auth model).
- **No documented rate limits** for anonymous use, though the service
  uses an internal fast/medium/slow priority-queue system rather than a
  hard cap.
- Positioned by its own maintainer as a complement to Overpass, not a
  full replacement — no history/attic data (irrelevant to TMAP), and
  presumably less battle-tested at scale than Overpass, which has run
  as OSM's primary query service for over a decade. Our own reliability
  data is 5 runs and one day of production traffic — a strong signal,
  not yet a long track record.

## 4. Design

### 4.1 Query construction

New function, same shape as the existing query builder:

```js
function buildPostpassQuery(bbox) {
  return `SELECT osm_id, geom, tags FROM postpass_line WHERE geom && ST_MakeEnvelope(${bbox.west},${bbox.south},${bbox.east},${bbox.north},4326) AND tags?'highway' AND tags?'name'`;
}
```

### 4.2 Response adapter

A pure function, `adaptPostpassResponse(geoJson)`, converting a Postpass
`FeatureCollection` into the exact array shape `fetchWays()` already
returns today (`[{type: 'way', id, tags, geometry: [{lat, lon}, ...]}, ...]`),
so `processWays()` and everything downstream needs **zero changes**.

```js
function adaptPostpassResponse(geoJson) {
  return geoJson.features.map((f) => ({
    type: 'way',
    id: f.properties.osm_id,
    tags: f.properties.tags || {},
    geometry: flattenMultiLineString(f.geometry)
  }));
}
```

**Resolved in Phase 0 (2026-07-31):** queried 7 diverse areas directly —
the 4 known benchmark locations plus 3 chosen specifically to stress-test
geometry complexity: Manhattan Midtown, the I-5/I-10/US-101/SR-60
interchange in East LA (one of the most complex interchanges in the US),
and Carmel, IN (deliberately chosen for its unusually high density of
roundabouts). Across **2,601 ways total, every single one came back as a
single-part `MultiLineString`** — `coordinates.length === 1` in every
case, no exceptions. `MultiLineString` appears to just be Postpass's
general packaging convention for line geometries, not a signal that a
way is actually split into disconnected parts. `flattenMultiLineString`
can safely just take `coordinates[0]`:

```js
function flattenMultiLineString(geometry) {
  if (geometry.coordinates.length > 1) {
    console.warn('Postpass returned a multi-part MultiLineString — unexpected, see spec §4.2', geometry);
  }
  return geometry.coordinates[0].map(([lon, lat]) => ({ lat, lon }));
}
```
The defensive `console.warn` (rather than silently mishandling it, or
throwing) is deliberate: if a genuine multi-part case ever does turn up
in production despite not appearing in this sample, we want to notice
it and decide a real policy then, not fail silently or crash on it.

### 4.3 Error classification

**Partially resolved in Phase 0 (2026-07-31).** Deliberately provoked a
malformed query (selecting a nonexistent column): confirmed **HTTP 400**,
`content-type: text/plain`, body a raw PostgreSQL error
(`pq: column "..." does not exist`) — matching the one earlier example
exactly, now confirmed as the general pattern, not a one-off. Since our
own query is always valid SQL we control, this specific failure mode
should only ever occur from a bug in our own query-building code, never
from real-world bbox/location variation — which is exactly why it's
classified `malformed` and *not* retried (§4.4): retrying a bug in our
own code just burns the budget on a guaranteed repeat failure.

Also deliberately sent a 10x-oversized query (5-mile half-side bbox
against Manhattan, vs. the app's real 0.5mi) specifically to try to
provoke a timeout or overload response. It didn't — Postpass returned a
14.3MB response in 1,029ms, no error at all. Reassuring for reliability,
but it means **we still have no direct observation of a genuine
timeout/rate-limited/server-error response from Postpass** — only the
malformed-query case above, and the sub-300ms "fetch failed" blips
during benchmarking that we already attributed to local network noise,
not the server. The mapping below remains reasoned from Overpass's
analogous behavior and general HTTP conventions, not verified against a
real Postpass failure of that kind:

| Condition | `OsmFetchError` kind | Confirmed against real Postpass? |
|---|---|---|
| `fetch()` throws (network/DNS/TLS failure) | `network` (unchanged) | Only local-network blips, not confirmed server-side |
| HTTP 400 (malformed query) | `malformed`, not retried | Yes — confirmed 2026-07-31 |
| HTTP 429 | `rate-limited` | No — never observed |
| HTTP 504 | `timeout` | No — never observed |
| Other HTTP 5xx | `server-error` | No — never observed |
| 200 OK but body isn't a `FeatureCollection` | new soft-failure check, mirroring Overpass's `remark`-field check (already prototyped in the benchmark script's `checkSoftFailure`) | No — never observed |

This isn't a blocker — the classification is sensible and errs toward
retrying anything genuinely ambiguous — but Phase 3's real-service retry
test (forcing failures against the live endpoint) is the first point
this table actually gets exercised for real, not just reasoned about.

### 4.4 Retry logic for Postpass requests

Unlike Overpass (kept exactly as it is today — single attempt, no retry
loop), Postpass requests get a client-side retry loop bounded by a fixed
**total time budget of 25,000ms** across all attempts combined —
deliberately mirroring Overpass's own `[timeout:25]` setting, so this
doesn't push the worst-case wait any higher than what the app already
tolerates today. It should make the *typical* case much better, since
most Postpass calls finish in under a second (§3's benchmark data) and
won't come close to needing the budget.

Two timers, not one:

- **Total budget: 25,000ms**, measured from when the first attempt
  starts. Once elapsed time would exceed this, stop retrying and throw
  — this is what decides when to give up, per the ask.
- **Per-attempt timeout: 8,000ms** (`AbortController`), so one slow or
  hung attempt can't silently consume the entire budget by itself and
  leave no room for a retry. Sized well above Postpass's typical latency
  (under 1s in benchmark data so far) but short enough that at least two
  or three attempts can still fit inside the 25s ceiling even in a bad
  case.

Backoff between attempts is short, not the benchmark script's
deliberately polite 30-second gaps (that cadence exists for periodic,
low-frequency background testing) — a live search has a user actively
waiting on it, so retries should happen fast: e.g. 250ms, then 750ms,
then 1,500ms, and only if the remaining budget can still fit another
attempt at all.

```js
const POSTPASS_TOTAL_TIMEOUT_MS = 25000;
const POSTPASS_ATTEMPT_TIMEOUT_MS = 8000;
const POSTPASS_BACKOFF_MS = [250, 750, 1500];

async function fetchFromPostpassWithRetry(bbox, requestId, country) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError;
  while (Date.now() - startedAt < POSTPASS_TOTAL_TIMEOUT_MS) {
    attempt += 1;
    const remainingMs = POSTPASS_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
    const attemptTimeout = Math.min(POSTPASS_ATTEMPT_TIMEOUT_MS, remainingMs);
    const attemptStart = Date.now();
    try {
      const ways = await fetchPostpassOnce(bbox, attemptTimeout);
      logOverpassQuery({ elapsedMs: Date.now() - attemptStart, errorType: null, country, dataSource: 'postpass', attempt, requestId });
      return ways;
    } catch (err) {
      lastError = err;
      logOverpassQuery({ elapsedMs: Date.now() - attemptStart, errorType: err.kind, country, dataSource: 'postpass', attempt, requestId });
      if (!isRetryable(err.kind)) break; // a malformed-query-shaped failure won't fix itself on retry
      const backoff = POSTPASS_BACKOFF_MS[Math.min(attempt - 1, POSTPASS_BACKOFF_MS.length - 1)];
      if (POSTPASS_TOTAL_TIMEOUT_MS - (Date.now() - startedAt) - backoff <= 0) break;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastError;
}
```

**What counts as retryable:** the existing transient-ish `OsmFetchError`
kinds — `network`, `timeout`, `rate-limited`, `server-error`. A
malformed-query-shaped failure (if Postpass turns out to surface one
distinctly — e.g. the plain-text SQL-error body seen once during
testing) should *not* be retried, since retrying a broken query just
burns the whole budget on a guaranteed repeat failure. Nailing down
`isRetryable()`'s exact rule depends on the same Phase 0/Phase 1
investigation into Postpass's real failure modes that §4.3 already
flags as unresolved — not a new open question, the same one.

The error thrown after every attempt is exhausted is the **last
attempt's own classified error**, not a new generic "gave up" kind — so
`humanizeOsmError()` needs no new cases, and the message shown to the
user stays accurate to whatever actually happened on the final try.

**Every attempt gets its own analytics row, not just the final
outcome** — this is what makes "how often do we need a retry, and does
it help" answerable from real data, the same way the benchmark script
already tracks every attempt in `results.csv`. See §4.6 for the two new
`overpassLogs` fields this requires (`attempt`, `requestId`).

Overpass's own *fetch and error-handling* logic is untouched by any of
this — still exactly one attempt, matching its current production
behavior. Its existing `logOverpassQuery()` call sites do get one small,
low-risk edit: adding `dataSource: 'overpass'`, `attempt: 1`, and
`requestId` so both sources land in a consistent schema (§4.6) — a field
addition to an existing call, not a change to how or whether Overpass is
fetched or how its failures are classified. If the retry model proves
out, extending it to Overpass (or whatever's left of that path) is a
natural follow-up, but isn't part of this migration.

### 4.5 Feature flag, not a hard cutover

Given this replaces the data source for the app's core feature — a
regression here breaks the primary user journey outright, unlike the
additive analytics/caching work shipped this week — this should land
behind an explicit switch, matching the existing
`USE_LOCAL_TEST_DATA_CACHE`/`USE_FIREBASE_EMULATORS` convention already in
`app.js`:

```js
const DATA_SOURCE = 'overpass'; // 'overpass' | 'postpass'
```

`fetchWays()`'s live-fetch branch (everything past the existing local
test-data cache check) becomes a plain if/else on this one constant, with
Overpass's existing code moved into the `else` untouched:

```js
async function fetchWays(bbox, searchQuery, country) {
  const cached = await loadLocalTestData(searchQuery);
  if (cached) return cached.ways;

  const requestId = crypto.randomUUID();
  if (DATA_SOURCE === 'postpass') {
    return fetchFromPostpassWithRetry(bbox, requestId, country); // new
  }
  // ...existing Overpass fetch code, unchanged, below...
}
```

That's the whole rollback surface: flip the constant back to `'overpass'`,
commit, push. GitHub Pages has taken roughly 20–30 seconds to go live for
every deploy this session — fast, but worth being precise that it's a
real (if quick) deploy cycle, not an instant runtime toggle. A
remote-config value (fetched at page load, changeable without a deploy at
all) would close that gap, but adds its own moving parts — another
fetch, another failure mode if *that* fetch fails — for a flag that, on
current evidence, would be flipped rarely. Given the other two flags in
this file (`USE_LOCAL_TEST_DATA_CACHE`, `USE_FIREBASE_EMULATORS`) are
already plain committed constants, staying consistent with that pattern
seems like the right default — flag if you'd rather have the faster,
heavier option instead.

One precision worth stating plainly: this is a **manual** switch, not an
automatic circuit breaker. Nothing in this design watches the error rate
and flips the constant on its own — someone (you, or me acting on your
behalf) has to notice `admin/overpass-stats` degrading and decide to roll
back. That's consistent with §5 explicitly deferring automatic
Overpass-fallback to a later phase, and with how every incident this
session actually got resolved — a human noticed something wrong and
acted — but it's a real property of the design worth naming rather than
assuming.

Two things that do **not** need any rollback action, because they're
harmless either direction:
- The `overpassLogs` schema additions in §4.6 are purely additive.
  Rolling back to Overpass doesn't require undoing them — old rows
  simply won't have `dataSource`/`attempt`/`requestId`, and new rows will
  correctly say `dataSource: 'overpass'`.
- The IndexedDB ways-cache (shipped 2026-07-29) doesn't know or care
  which service produced its cached ways. If a user's browser cached a
  Postpass-sourced map right before a rollback, their next reload still
  shows that cached map — which is fine, since it's real, valid street
  data regardless of which service produced it. Rolling back is about
  future reliability, not correcting already-cached data.

### 4.6 Analytics: tag which source served each query, and every retry attempt

Three new fields on the `overpassLogs` write in `logOverpassQuery()`:

- `dataSource` (`'overpass'` or `'postpass'`) — this is what makes Phase
  4 actually verifiable from real production traffic, and lets
  `admin/overpass-stats` report on both sources side by side once
  there's a mix of historical data from each.
- `attempt` (1-indexed) — which try within the retry loop (§4.4) this
  row represents. Always `1` for Overpass, since that path never
  retries.
- `requestId` — a random ID (`crypto.randomUUID()`) generated once per
  `fetchWays()` call and attached to every row it produces, so the
  several rows from one search's retry sequence can be grouped without
  relying on fragile timestamp-proximity heuristics.

No `firestore.rules` change needed — these are just additional fields on
an existing create-only document. `overpass-stats.mjs` needs updating to
break down failure rate/latency by `dataSource`, and to report an
"average attempts needed per search" metric using `requestId` grouping.
It also needs to handle the ~49 existing rows logged before this
migration gracefully — they predate all three new fields, so the script
should treat a missing `dataSource` as `'overpass'` (accurate — that's
all that existed then) and a missing `requestId` as its own singleton
group, rather than erroring on `undefined`.

### 4.7 What does NOT change

- Recent Maps / Saved Maps Firestore documents — metadata-only, never
  stored ways, unaffected regardless of data source.
- The local ways-cache (IndexedDB) — stores whatever shape `showAnchor()`
  receives, which is identical either way post-adapter.
- The dev-only local test-data cache and `test-data/fetch-test-data.mjs`
  — keeps fetching from Overpass to populate fixtures, since those files'
  job is to freeze a known-good Overpass response for offline dev
  testing, not to track whatever the live data source currently is.
- `admin/benchmark/` — already queries both services independently for
  comparison; no change needed, though its Postpass query string is the
  reference implementation for 4.1 above.

## 5. Explicitly out of scope for this change

- Self-hosting Overpass, mirror rotation, or the paid Geofabrik Overpass
  tier — all discussed earlier this session as alternatives; this spec
  is specifically about the Postpass swap, not a re-litigation of that
  comparison.
- Keeping Overpass as an automatic fallback if Postpass fails (race or
  sequential retry across both services) — worth considering *after*
  Postpass has a real production track record, not as part of the first
  cutover. Bundling that in now would make it harder to attribute a
  problem to one service or the other.
- Any change to the bbox size (`POI_DISTANCE_THRESHOLD_MILES`) or query
  filter semantics (still `highway` + `name` present) — this is a
  data-source swap, not a feature change.

## 6. Work plan

Each phase has an explicit gate before moving to the next — given this
session's two live-site incidents (a temporal-dead-zone crash and a
disabled-auth-provider bug, both of which passed a naive "does it look
done" check but broke production), nothing here ships past Phase 3
without deliberate, realistic-state browser verification, not just
`node --check`.

### Development environment: build this in `tmapdev`, not `tmap`

Now that real users are on the live site — the whole reason the
analytics work this week exists — **Phases 0–4 below happen entirely in
a separate `tmapdev` repo and deployment**, a full independent clone of
`tmap` (not a branch), so none of this migration touches the live site
until Phase 5 deliberately moves the finished work back. `tmapdev`
deploys to `touchout.org/tmapdev` — same domain as production, so the
existing Google Maps API key restriction and Firebase Auth authorized-
domains setting already cover it, no new key or domain config needed —
and shares the same `dottmap-fire` Firebase project as production.

Because it's the same origin (`touchout.org`), two safeguards need to be
in place *before* development starts, not retrofitted afterward:

- **Storage-key namespacing.** `dottmap-settings`, `dottmap-current-map`,
  and the `dottmap-ways-cache` IndexedDB database are plain strings the
  app defines itself, and same-origin means `tmap` and `tmapdev` would
  otherwise read and write the *literal same* stored values, not
  separate copies — whichever site last wrote a setting, a current map,
  or a cached ways payload is what the *other* site restores on its next
  load. (Firebase Auth's own session storage is namespaced by API key
  internally and wouldn't collide even so — this is specifically about
  the app's own hand-chosen key names.) `tmapdev`'s build needs its own
  suffixed key names (e.g. `dottmap-settings-dev`,
  `dottmap-current-map-dev`, a distinct ways-cache database name),
  gated on which build is running — not a manual step to remember.
  **Confirmed working 2026-07-31** — shipped as part of the environment
  setup, verified live (a fresh `tmapdev` load doesn't restore `tmap`'s
  old shared current-map, confirmed via a real Chrome tab reading
  `localStorage`/`indexedDB.databases()` directly), and independently
  re-confirmed by Josh testing both read and write paths himself.
- **An unmistakable `buildId` prefix** — e.g. `tmapdev-2026-07-30`
  instead of the plain date string `tmap` uses — so `tmapdev`'s test
  traffic is self-evidently separable from real production traffic in
  `overpassLogs`, without anyone having to remember which dates were dev
  builds.

Also worth doing given `tmapdev` sits at a real, publicly-reachable URL
on the production domain: keep it out of search indexing (`robots.txt`
disallow or a `noindex` meta tag), and show a visible "development
build — do not sign in with your real account, nothing saved here is
guaranteed to persist" banner, matching the existing dev-cache/dev-
emulator banner pattern already in `app.js`. Namespacing local storage
protects settings/current-map/ways-cache, but signing in with a real
Google account on `tmapdev` still touches the *same* Firestore-backed My
Archives data as production (shared Firebase project) — the banner is
what protects against that, since no code change here removes that
sharing.

**Phase 0 — Resolve open questions (no code) — DONE 2026-07-31**
Queried 7 diverse areas directly (the 4 benchmark locations plus
Manhattan Midtown, the East LA highway interchange, and Carmel IN's
roundabouts) — 2,601 ways total, zero multi-part geometries, resolving
§4.2 cleanly. Deliberately provoked a malformed query (HTTP 400,
plain-text PostgreSQL error) and a 10x-oversized query (handled fine,
14.3MB in ~1s, no error) — confirms the `malformed`/non-retryable
classification for bad queries, but genuine timeout/rate-limited/
server-error responses still haven't been directly observed against
Postpass (see §4.3's table). Not a blocker for Phase 1, but Phase 3's
real-service retry test is still where that classification gets its
first real exercise.

**Phase 1 — Pure functions, no integration — DONE 2026-07-31**
Wrote `buildPostpassQuery()`, `flattenMultiLineString()`,
`adaptPostpassResponse()`, `checkPostpassSoftFailure()`,
`fetchPostpassOnce()`, and `fetchFromPostpassWithRetry()` in
`tmapdev/app.js`, right after the existing (unmodified) `fetchWays()` --
nothing calls them yet. Also extended `classifyHttpFailure()` with a
`malformed` kind for HTTP 400 (shared with Overpass's existing path, and
added its user-facing message to `OSM_ERROR_MESSAGES` immediately, since
that function is already live in production), and gave
`logOverpassQuery()` default `dataSource='overpass'`/`attempt=1`/
`requestId=null` parameters so the existing Overpass call sites need no
edits to keep a consistent schema.

Verified the adapter against real data: queried both services for the
same Berkeley/Hearst bbox. 339 Overpass ways vs. 342 Postpass ways, tier
histograms matching within the same small margin, 66 vs. 67 distinct
street names with only one name present in Postpass but not Overpass
("Milvia Street") -- consistent with ordinary mirror lag, not an adapter
bug. A sample adapted way's shape (type/id/tags/geometry) matched
exactly what `processWays()` and rendering expect.

Verified the retry loop's mechanics with a mocked `fetch`, using the
exact function as written (not a re-derivation): an always-failing mock
gave up after 18 attempts at 23,671ms, within budget; a mock that hangs
20s per call (far past the 8s cap) was correctly cut off near 8s each
time, fitting exactly 3 attempts into the 25s window before giving up;
a mocked HTTP 400 stopped after exactly 1 attempt in 1ms, confirming
`malformed` isn't retried.

Original text below, retained for what Phase 1 was scoped to do (see
above for what actually happened):

Write `buildPostpassQuery()`, `adaptPostpassResponse()`, the
soft-failure check, and `fetchFromPostpassWithRetry()` (§4.4) as
standalone functions. Verify the adapter by hand: take a real Overpass
response and a real Postpass response for the *same* bbox, diff way
counts, tag sets, and tier distribution after `processWays()`. They
won't be identical (different OSM mirrors can lag each other slightly)
but should be close; large discrepancies mean the adapter or query
filter is wrong, not that the data sources disagree. Verify the retry
loop separately with a mocked/stubbed fetch: confirm it stops within the
25s total budget under an always-failing mock, confirm a single
long-hung attempt doesn't consume the whole budget (the 8s per-attempt
cap kicks in), and confirm a non-retryable failure kind stops
immediately rather than burning through backoff attempts.

**Phase 2 — Integrate behind the flag, default off — DONE 2026-07-31**
Wired `DATA_SOURCE` into `fetchWays()`. Deployed to `tmapdev` with the
flag at its default (`'overpass'`) and confirmed live: a real search
went through the new branch, correctly skipped it, and completed a
genuine Overpass fetch exactly as before (title updated to "1516 Hearst
Avenue, Berkeley, California, 94703", no console errors beyond an
unrelated browser-extension artifact). Zero behavior change confirmed,
not just assumed from the diff being small.

**Phase 3 — Local verification with the flag on — DONE 2026-08-01**
Using a local static server (`python -m http.server`, not the sandboxed
test harness that's proven unreliable for this app — verified against a
real Chrome tab instead) with `DATA_SOURCE` temporarily flipped to
`'postpass'` locally (never committed at that value).

**Found and fixed a real bug on the very first search**, exactly the
kind of thing this phase exists to catch: `fetchPostpassOnce` posted to
Postpass with no `Content-Type` header, so the browser defaulted to
`text/plain`. Postpass couldn't parse the `data=` field and returned
HTTP 400 (`"no query field given"`), which the app correctly classified
as `malformed` — every single query failed this way, 100% of the time,
regardless of location. Confirmed root cause directly (`curl` with vs.
without `Content-Type: application/x-www-form-urlencoded` against the
identical query — 400 vs. a valid 200 FeatureCollection). The benchmark
script (`admin/benchmark/overpass-vs-postpass.mjs`) already set this
header correctly, which is why Phase 0's testing never surfaced it — the
gap was specifically between the verified-working script and the
never-actually-exercised app code, which is exactly why code review and
isolated-function testing (Phase 1) didn't catch it either. Fixed by
adding the header ([app.js](app.js) `fetchPostpassOnce`); this is the
one change from this phase that stays in the codebase.

With the fix in place, re-verified all 4 known benchmark locations plus
one new one (560 Riverside Dr, New York — chosen for its numbered/
directional/ordinal street names). For each, opened the Street
Abbreviation Key and confirmed **real, geographically correct street
names** (e.g. California St/Jackson St/Pacific Ave for the SF anchor;
West 125th–133rd St/Broadway/Riverside Dr for the Harlem anchor,
including the documented `"West 134th Street (upper)"` → `w34` collision
case actually occurring in real data) — ruling out the silent-wrong-data
risk (a lat/lon swap would have produced nonsense streets in the wrong
place, not this). SVG export verified too (`Download SVG` on the Harlem
anchor): valid SVG, correct `data-name`/`data-stem`/`data-type`/
`data-label`/`data-highway`/`data-tier` per street group, correct 3x3
POI marker.

Retry loop verified end to end by temporarily pointing `POSTPASS_URL` at
an unroutable address (`10.255.255.1`, never committed) and reading the
real `overpassLogs` rows back afterward (via a throwaway read-only
script using the existing `overpass-stats-reader` service account, same
approach as `admin/overpass-stats/`): a single `requestId` logged 4 rows
with `attempt` 1→4, error kinds `timeout`/`timeout`/`network`/`timeout`,
spanning ~24.9s total — right at the 25s budget — before the search
failed with the existing "query took too long" message. The 5 healthy
searches above each logged a single `attempt: 1` row at ~1.2–1.7s,
confirming the retry machinery adds no overhead on the happy path.

**Phase 4 — Soak-test live on `tmapdev`, flag on, before touching `tmap` — STARTED 2026-07-31**
`DATA_SOURCE` flipped to `'postpass'` and deployed (commit `bb2a0c2`,
live at `touchout.org/tmapdev` as of 2026-07-31 23:29 PDT) — still only
`touchout.org/tmapdev`, `tmap`/production completely untouched.
Confirmed working against real traffic immediately after deploy (a real
search hit `postpass.geofabrik.de` and rendered correctly). Now: use it
as a real daily driver for genuine searches (not just the scripted
Phase 3 checks) for at least a few days, watching `admin/overpass-stats`
(broken down by `dataSource`, and by `buildId` since `tmapdev`'s builds
are self-evidently separable from production traffic — see the
`tmapdev-` prefix above) for real-world reliability and latency, not
just the handful of locations Phase 3 exercised. Don't mark this phase
DONE on deploy alone — see its own criteria below for what "done"
actually means. Rollback here is trivial and low-stakes precisely
because no real users are on `tmapdev` — flip the flag back or just keep
developing. This phase exists specifically so the *first* time Postpass
carries real, unscripted, unpredictable traffic is somewhere a bug can't
reach production users — the same reasoning behind testing every push on
real
Dot Pad hardware rather than trusting it "should" work.

**Phase 5 — Merge back into `tmap`, then a soft production rollout — STARTED 2026-08-01**
Cut short of the original "at least a few days" soak target — Josh
called it early because live Overpass reliability kept degrading further
during Phase 4 (see `admin/overpass-stats`), making the urgency of
shipping the fix outweigh waiting out the full soak window. `tmap`'s
`app.js` was replaced with `tmapdev`'s current one wholesale rather than
via the originally-planned second-remote git merge — the two files
differ *only* in the Postpass migration itself (confirmed via
`git diff tmap-prod/main HEAD -- app.js` before copying), so a direct
copy was the safer, more auditable move under time pressure than
untangling tmapdev's environment-setup commit from its migration commits
in a live git history merge. No manual reversion of storage-key
namespacing/`buildId` prefix was needed — `IS_DEV_BUILD` (see
`tmapdev`'s environment setup above) evaluates to `false` on `tmap`'s
own domain path by construction, so the file is safely byte-identical
between the two repos as designed. `index.html`/`robots.txt` (the only
other files `tmapdev` had touched, both purely dev-banner/`noindex`
additions) were left untouched in `tmap`. `DATA_SOURCE` was already
`'postpass'` in the copied file (Phase 4's flip), so this deploy flips
production directly rather than doing the extra overpass-first
verification deploy — release notes entry added same day. Now: watch
`admin/overpass-stats` for real *production* traffic before considering
this phase settled — Phase 4's tmapdev data is encouraging evidence, not
a substitute for watching production itself. Rollback at any sign of
trouble is the one-line flag flip, not a git revert.

**Phase 6 — Decide what's next (after Phase 5 production data, not before)**
Once there's a real production track record: decide whether to keep
Overpass code as a permanent fallback path, or retire it. Not a decision
to make upfront.

## 7. Success criteria

- Phase 4's live `tmapdev` data and Phase 5's production
  `admin/overpass-stats` data both show Postpass's failure rate and p95
  latency meaningfully better than Overpass's historical 29.2%/11.6s
  figures, sustained over multiple days, not just a lucky window.
- No user-visible regression in map correctness (way count, names,
  tiers) versus the Overpass-sourced maps that came before.
