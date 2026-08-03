# DotTMAP Spec

This is the evolving spec for Dot Pad TMAP. 

## Overview

This accessible tactile street map web app is highly compatible with the NVDA screen reader and optimized for Chrome. It uses a standard on-screen UI for controlling the experience: controls are displayed on screen, standard focus and screen reader navigation is supported, and hotkeys are offered for most parts of the experience. ARIA live regions ensure that some elements automatically announce themselves when they update.

The Dot Pad is connected via BLE. It is the primary map display, showing graphics and braille labels on the 60x40-pixel tactile display, as well as relevant text on the 20-cell message display. The 6 keys on the device can be used for certain types of input and control.

### Hardware requirement

The Dot Pad is required to actually view the tactile map, but it is not required to use the app. No feature or function of the site should fail, complain, or block the user if no Dot Pad is connected — a user without a connected device can still search for locations, build up a map, add pins, and save it to their archives; they just won't be able to feel it until a device is connected.

### Browser check

On load, the app checks whether the browser is Chrome. If it isn't, a warning appears: "This App works best in Chrome. Please switch to Chrome so you can connect to the Dot Pad." This check exists because Dot Pad connectivity depends on Web Bluetooth, which only Chromium-based browsers support. The warning does not block use of the app (per Hardware requirement, above, connecting a Dot Pad is never mandatory) — a non-Chrome user can still search, build, and save maps, they just can't pair a device.

### Data sources

DotTMAP uses **Google's Geocoder** (`google.maps.Geocoder`, via the Maps JavaScript API) for geocoding (turning a searched location into coordinates) and Open Street Map's **Overpass API** for street/way data. Geocoding was originally Nominatim; it was switched to Google to evaluate whether address/pin-search reliability improves (Nominatim's matching was inconsistent for some real-world queries). Overpass/street data is unaffected by this — still OSM.

**Live street-data source (as of August 2026): Postpass, not Overpass.** Street/way data is currently fetched from **Postpass** (`postpass.geofabrik.de`), a free, PostGIS-backed OSM query service also run by Geofabrik that answers plain SQL queries over the same underlying OpenStreetMap data Overpass serves. Overpass is still described throughout the rest of this section, and its code path is still fully intact in `app.js` — it's just not the one currently live. The switch is controlled by a single `DATA_SOURCE` constant (`'overpass'` | `'postpass'`); flipping it back and redeploying is the entire rollback path if Postpass ever needs to be backed out, no code revert required. The switch was made because Postpass measured meaningfully more reliable and faster: production `overpassLogs` data showed Overpass's failure rate reaching 29.2% over a 24-hour window with a p95 latency of 11.6s even among successful queries, while side-by-side benchmarking (`admin/benchmark/results.csv`) showed Postpass completing every one of 19 checks without a single retry, averaging 723ms, versus Overpass needing a retry in 4 of 19 (21%) and averaging 4,014ms. See `postpass-migration-spec.md` for the full migration history and design.

The Maps JavaScript API is loaded lazily (`loadGoogleMaps()`, once per page load, not until the first search) via the standard bootstrap `<script>` tag against a client-side API key (`GOOGLE_MAPS_API_KEY`, restricted to the Maps JavaScript, Places, Places (New), and Geocoding APIs and to the touchout.org/localhost origins — not secret, same trust model as the Firebase key already in this file). `geocode()` converts Google's `GeocoderResult` (`address_components` + `geometry.location`) into the same shape the rest of the app has always consumed (originally Nominatim's `{lat, lon, display_name, name, address: {...}}`), so `formatPlaceName`/`formatShortAddress` and the local test-data cache didn't need to change. One real behavior difference: **`place.name` is always `null`** for a Geocoder result — Geocoder resolves addresses, not business/pin names, so a search that used to match a business (e.g. a cafe at a given address) now just resolves to that address with no business name attached, *except* via the "Did you mean...?" fallback below, which does surface business names.

**"Did you mean...?" fallback (implemented):** when `geocode()` finds nothing at all (Geocoder's `ZERO_RESULTS` — not a partial match, which is already a usable result), `searchPlacesTextFallback()` retries the same query against Google's **Places API (New)** Text Search (`google.maps.places.Place.searchByText()`, a separate enabled API/service from both the Maps JavaScript API and the classic Places API — Google splits these into distinct services despite the overlapping names). Places' Text Search is a relevance-ranked, typo-tolerant search rather than deterministic address resolution, so it succeeds on plenty of queries Geocoder can't parse at all (a garbled business name with no city, for instance). Up to 10 ranked candidates are shown in a "Did you mean...?" modal (`<dialog id="did-you-mean-dialog">`), each as a button styled to read as a link (`.candidate-link` — a real `<button>`, not an `<a>`, since it performs an in-page action rather than navigating; same reasoning as the existing `.sort-header` pattern in My Archives). Picking one closes the dialog and calls `proceedWithPlace()` — the same anchor/additional-pin/too-far-for-one-map logic an ordinary successful geocode already goes through, refactored out of `runSearch()` so both paths share it. Cancel closes the dialog with no further action; no map data is fetched. If the fallback search *also* finds nothing (or the fallback call itself fails), no dialog appears — it's reported exactly like an ordinary miss, "No results," rather than a separate error, since a failure this deep isn't worth surfacing as anything more specific than the address lookup that already failed.

Overpass data is fetched for a square region centered on the anchor pin, with a half-side length equal to the current pin distance threshold setting (see [Settings](#settings)). This square is the map's data boundary — see [Pan Behavior](#pan-behavior) for what happens when panning reaches its edge. Fetching a larger region (e.g., to let panning extend further) is a possible future enhancement, not required now.

Any geocoding/Overpass error (network failure, rate-limiting, no results, etc.) must be surfaced rather than fail silently — reported to the message field per [Message display architecture](#message-display-architecture), so there's enough visibility to debug what went wrong. This is P0: the exact wording/retry behavior can be refined later, but silent failure is never acceptable.

**Error classification (implemented):** `geocode()` and `fetchWays()` each throw an `OsmFetchError` carrying a `kind` — `network`, `rate-limited`, `timeout`, or `server-error` — using the same shared vocabulary regardless of which provider failed. For Overpass: `network` (the `fetch()` call itself threw, before any response), `rate-limited` (HTTP 429), `timeout` (HTTP 504, **or** a 200 OK response carrying an error `remark` field — Overpass reports some server-side failures, like a query timeout, this way instead of a non-2xx status, so this case is checked explicitly rather than relying on `res.ok`), or `server-error` (anything else non-OK, message includes the raw status code). For Google's Geocoder: `network` (the Maps JS script itself failed to load), `rate-limited` (`OVER_QUERY_LIMIT`), `timeout` (`UNKNOWN_ERROR` — Google's docs describe this as transient/retry-likely-to-succeed), or `server-error` (`REQUEST_DENIED`, `INVALID_REQUEST`, etc. — message includes the raw `GeocoderStatus` string instead of a numeric code). `humanizeOsmError(err, stage)` turns the classification into the actual sentence shown, worded separately for the `'address'` (geocoding) vs `'street-data'` (Overpass) stage so the message names which lookup failed and which provider (Google vs OpenStreetMap); it also `console.error`s the raw error, which nothing did before this was added. A genuinely unmatched address (Geocoder's `ZERO_RESULTS`, not an error) is unaffected — still reported as "No results" separately, since that's a distinct, already-clear case. Retry behavior remains unimplemented, per the "can be refined later" note above.

### Message display architecture

The message field (the on-screen print version of the message display, an ARIA live region) is the single source of truth for anything announced to the user — not the Dot Pad's 20-cell message display or speech output. Whenever something needs to be reported (pan status, scale changes, current-object names under the cursor, label toggle state, etc.), the app updates the message field first; that update then pushes to the Dot Pad message display and separately triggers the ARIA live announcement. The Dot Pad display and speech are downstream reflections of the message field, never independently-driven outputs.

The on-screen/ARIA side is never length-limited — the full message always shows there and is what speech announces. Only the physical Dot Pad's message display has an actual hardware limit (20 cells), so only its copy is paginated, via the **virtual message window** below.

#### Virtual message window

The Dot Pad's message display can show 20 braille characters at a time, but messages may be longer than that. Rather than truncating, the app keeps the full translated message in a virtual window and pages the device through it:

* Whenever a new message is set, it's translated under the currently active braille code (see [Braille translator](#braille-translator)) and the **first** 20-cell-or-fewer chunk is shown automatically.
* Dots 4+5+6 together show the next chunk; dots 1+2+3 together show the previous one.
* Chunks break at word boundaries. If a single word is itself longer than 20 cells, that one chunk is hard-cut.
* If there's no next/previous chunk (already at the last/first one), the edge tone plays (see [Sound cues](#sound-cues)) but nothing else changes — no message-field update, no device write, the display just keeps showing what it already had.
* Pagination is always computed against the *translated* cell sequence, never the raw source text, since the two can have very different lengths. When the Braille Translation setting changes (see [Settings](#settings)), the currently-displayed message is re-translated under the new code and re-paginated from its first chunk — chunk boundaries don't line up between codes (a contraction-heavy code and a plain one chunk the same text differently), so there's no meaningful "same position" to preserve across a code change.
* There's no keyboard equivalent for paging — the on-screen/ARIA message is never truncated in the first place, so a keyboard/screen-reader user already has the complete message without needing to page through anything; the 20-cell limit is purely a physical-device constraint.

### Sound cues

Alongside the message field, a short synthesized tone is a secondary, non-verbal cue for certain events — Edge of Map (see [Pan Behavior](#pan-behavior), a beep when a pan is rejected) and the message display's own edge (see [Virtual message window](#virtual-message-window) above, a beep when paging past the first/last chunk) share the same tone. Cues are short tones generated with the Web Audio API (an oscillator, no external library or audio file needed).

This is meant as a general pattern, not a one-off for Edge of Map specifically: sound is a plausible secondary cue for a variety of future events (e.g., a save completing, an error, reaching a boundary of some other kind) where a quick non-verbal signal is useful alongside — never instead of — the message field, which remains the single source of truth for what actually happened. Specific additional cues aren't designed yet; this section exists so the pattern (and the "no external library needed" fact) doesn't need rediscovering each time one comes up.

## Screen Layout

The default page title is "DotTMAP — Tactile Street Maps for Dot Pad". When a map has been loaded or created, the title of the current street map replaces the part of the title following the em dash (e.g., "DotTMAP — 123 Main Street, Springfield").

Top to bottom, left to right:

* At the very top of the page, before the H1: "Connect Dot Pad" button, then the **Main Menu** button. 
* H1: "Welcome to DotTMAP"
* Before any map exists: instructional text ("To get started, connect your Dot Pad, then use the New Map button to search for any address or location. Try the Help button for more information.") followed by a standalone **New Map** button. Once an anchor pin exists, the instructional text disappears (to make more room for the map) and the button is replaced by the **Map Menu** — see [New Map / New Pin](#new-map--new-pin) below for both, plus [Edit Pin](#edit-pin).
* Below that: H2 with the found address (anchor pin).
* Below the H2: the visual representation of the map.
* Immediately below the map: a print version of the message display (live ARIA region).
* Panning has no on-screen control group — see [Pan Behavior](#pan-behavior) for the two ways it's actually done.

### Main Menu

A WAI-ARIA "Actions Menu Button" opened by the "Main Menu" button at the top of the page (see [Screen Layout](#screen-layout)). Selecting an item takes effect immediately and closes the menu — there's no persistent "currently selected" indicator, since every item is an action, not a standing option. Contains, top to bottom:

* **"Display Preferences"** — opens the settings dialog, see [Settings](#settings). Always enabled.
* **"Customize Map"** — opens the map-editing dialog, see [Editing the Map](#editing-the-map). Disabled (present but not activatable, `aria-disabled`, not native `disabled` — so it stays keyboard-navigable) until an anchor pin exists.
* **"My Archives"** — opens the archives dialog, see [Saving and exporting](#saving-and-exporting). Available whether signed in or not (the current map's own row works locally without an account); the Map History and Saved Maps sections each show a sign-in prompt in place of their Firestore-backed content while signed out.
* **"Help"** — opens a Help dialog documenting every hotkey/Dot Pad key combo plus a brief non-hotkey section for each dialog, see [Help](#help). Always enabled.
* **"Release Notes"** — opens a dialog listing user-facing changes by date, see [Release Notes](#release-notes). Always enabled.
* **"Download SVG"** — see [Download to Local SVG](#download-to-local-svg). Same disabled-until-anchor condition as Customize Map.
* **"Login"** / **"Logout"** — one shown at a time depending on sign-in state, same convention as Connect/Disconnect Dot Pad below. See [Authentication](#authentication).
* **"Disconnect Dot Pad"** — only present at all while a Dot Pad is connected; entirely absent (not just disabled) while disconnected. This is the counterpart to the main-screen "Connect Dot Pad" button — the two are never both present, and Disconnect never appears on the main screen itself.

"Connect Dot Pad" (from the Dot Pad SDK) lives on the main screen, not in the Main Menu, and receives keyboard focus automatically when the page first loads. It's shown only while disconnected; once connected, it's removed from the main screen entirely and "Disconnect Dot Pad" appears at the bottom of the Main Menu instead. Connecting or disconnecting reports status through the message field, per [Message display architecture](#message-display-architecture).

### Command / hotkey mapping

The following table specifies the functions that can be accessed from the app or from the device with hotkeys or key combinations.

| Function | App Hotkey | Dot Pad Key Combo |
| --- | --- | --- |
| Cursor Up | Up arrow | dot 2 |
| Cursor Down | Down arrow | dot 5 |
| Cursor Left | Left arrow | dot 3 |
| Cursor Right | Right arrow | dot 6 |
| Pan Up | Ctrl+Up arrow | dots 1+4 |
| Pan Down | Ctrl+Down arrow | dots 3+6 |
| Pan Left | Ctrl+Left arrow | dots 1+3 |
| Pan Right | Ctrl+Right arrow | dots 4+6 |
| Increase Scale (zoom out) | `[` | dots 2+3 |
| Decrease Scale (zoom in) | `]` | dots 5+6 |
| Toggle Labels Top | `i` | dots 1+3+6 (`u`) |
| Toggle Labels Bottom | `k` | dots 1+3+4 (`m`) |
| Toggle Labels Left | `j` | dots 2+4+5+6 (`w`) |
| Toggle Labels Right | `l` | dots 1+2+3+5 (`r`) |
| Map Complexity: All streets and pathways | `1` | none |
| Map Complexity: Simplified neighborhoods | `2` | none |
| Map Complexity: Major streets | `3` | none |
| Map Complexity: Major highways | `4` | none |
| Cycle Map Complexity (decreasing, wraps) | `x` | dots 1+3+4+6 (`x`) |
| Toggle cursor-only mode | `0` | dots 3+5+6 |
| Open New Map dialog | `n` | none |
| Open New Pin / Edit Pin dialog | `p` | none |
| Next Pin | `.` | dot 4 |
| Previous Pin | `,` | dot 1 |
| Next message chunk | none | dots 4+5+6 |
| Previous message chunk | none | dots 1+2+3 |
| Open Street Abbreviation Key | `/` | dots 3+4 |
| Scroll Street Abbreviation Key forward | none | dots 4+5+6 |
| Scroll Street Abbreviation Key backward | none | dots 1+2+3 |
| Close Street Abbreviation Key | Esc | dots 1+2+3+4+5+6 |
| Open Help | `h` or `?` | none |

Every keyboard hotkey fires only on its exact key with no extra modifier held — Ctrl/Alt/Meta always fall through to the browser/OS/screen reader instead, so a shortcut like Ctrl+A is never captured by the app. Pan (Ctrl+arrow) is the one hotkey that requires a modifier, and it requires exactly Ctrl and nothing else.

Toggling a label setting from the keyboard reports the new state in the message field, in the form "top labels on/off" (etc.), which is mirrored to the Dot Pad message display. As with all message-display updates, the app-side field is the source of truth: it updates first, then pushes to the Dot Pad and triggers the ARIA live announcement — see [Message display architecture](#message-display-architecture).

The 1-4 hotkeys jump straight to a Map Complexity level (see [Editing the Map](#editing-the-map)) without needing to open the Edit Map dialog, announcing "[level] visible." in the message field. If the dialog happens to be open, its Map Complexity radio button stays in sync no matter which path changed it.

`x` (keyboard or Dot Pad, both the same command, sharing the letter's own braille cell — dots 1+3+4+6) steps through the same four levels one at a time in decreasing-complexity order (All streets and pathways → Simplified neighborhoods → Major streets → Major highways), wrapping back to All streets and pathways past the end — a single "simplify one more step" command instead of needing to know which specific 1-4 level to jump to. Same announcement and dialog-sync behavior as 1-4.

`0` (keyboard or Dot Pad dots 3+5+6, both the same command) hides every currently-visible street and pin and shows only the cursor, announcing "Cursor only"; pressing it again (either input) restores exactly what was showing before (whatever combination of Visible/Hidden Streets, Hidden Features, and Map Complexity was already in effect), announcing "Features restored." This is a display-only override — it never changes any of that underlying state, and `.`/`,` pin navigation keeps working normally throughout, since it's a navigation aid rather than a rendered map feature.

**Cursor Solo Timeout** (see [Settings](#settings)) optionally reverts cursor-only mode back to "Features restored" on its own, a fixed number of seconds after it's turned on — so it doesn't have to be remembered and manually turned back off. Turning it off manually before the timeout elapses cancels the pending auto-revert, same as if the timeout feature didn't exist; the two paths (manual and automatic) end up in exactly the same state either way. Changing the Cursor Solo Timeout setting while cursor-only mode is already active and counting down takes effect immediately, per the Settings dialog's live-apply rule (see [Editing the Map](#editing-the-map)) — the pending countdown restarts under the new duration rather than waiting to expire under the old one, or is cancelled outright if the new value is None. Setting it to None disables the auto-revert entirely — manual toggle only, the original behavior before this setting existed. A brand-new anchor search always cancels any pending countdown, the same way it resets `cursorOnlyMode` itself, so a stale timer from a discarded map can never fire against a new one.

`n` opens the New Map dialog, described under [New Map / New Pin](#new-map--new-pin). `p` opens New Pin, or [Edit Pin](#edit-pin) instead if the cursor is currently on a pin — the two are never available at once, so `p` covers both. `a` does the same thing as `p` (including the Edit Pin swap), kept quietly for muscle memory from before this dialog was renamed, but not documented anywhere user-facing (this is the one exception to "every hotkey is documented" in this file, deliberate).

Cursor rows use the same dot mapping as [Cursor and hit testing](#cursor-and-hit-testing). Toggle Labels Top and Bottom complete the set of 4 label positions, matching the left/right/top/bottom checkboxes in [Settings](#settings).

The `i`/`j`/`k`/`l` keyboard hotkeys, the `u`/`m`/`w`/`r` Dot Pad key combos, and the Braille Labels dialog's four checkboxes all drive one shared piece of state, not separate ones. Any of the three work regardless of whether the dialog is open; whenever the dialog is opened (or reopened), each checkbox simply reflects whatever that shared state currently is — there's no separate sync step, the checkbox display is a live view of the same toggle the hotkeys and Dot Pad combos set. The Dot Pad combos exist so labels can be toggled without touching the QWERTY keyboard at all; each one's dot pattern is that letter's own braille cell (`u` = dots 1+3+6, etc.), not a mnemonic tied to "top/bottom/left/right" — same convention as the pan/scale/cursor combos above.

`/` (keyboard) or dots 3+4 (Dot Pad) open the Street Abbreviation Key — see [Street Abbreviation Key](#street-abbreviation-key) below — regardless of whether a map is loaded, same as the label-zone toggles above. While it's open, dots 4+5+6 / 1+2+3 page it forward/backward instead of the message window (they're the exact same combos, just redirected while the dialog is open — see [Message display architecture](#message-display-architecture)), and every other keyboard/Dot Pad hotkey is suppressed. Escape or dots 1+2+3+4+5+6 close it and put the map right back on the device.

`h` or `?` opens Help (see [Help](#help) below) regardless of whether a map is loaded, same as `/` above. Re-pressing either key while Help is already open is a no-op rather than an error — `openHelpDialog()` checks the dialog's own `open` state first, since the Close button that receives focus when it opens isn't a form control and so wouldn't otherwise block the hotkey from firing again.

## Help

Opens from the Main Menu, the **Help** button in the page footer (next to File an Issue), or the `h`/`?` hotkey — see [Main Menu](#main-menu). A single dialog covering every hotkey/Dot Pad key combo in the app, plus a brief description of each dialog that doesn't have its own hotkey.

Sections, in order: Getting Started, Help, Connecting the Dot Pad, Cursor Movement, Panning, Scale and Map Complexity, Pins, Braille Labels, Message Display, Street Abbreviation Key, New Map, New Pin, Edit Pin, Display Preferences, Automatic Simplification, Map Customization, My Archives, Login / Logout, Release Notes. The eight hotkey-table sections (Help, Cursor Movement, Panning, Scale and Map Complexity, Pins, Braille Labels, Message Display, Street Abbreviation Key) each use a 4-column table — Function, Hotkey, Dot Keys, Description — reproducing the same bindings as the [Command / hotkey mapping](#command--hotkey-mapping) table above, just grouped by topic with a plain-language description per row rather than one flat table (Street Abbreviation Key additionally has its own intro paragraph, same as Message Display). The remaining sections (Getting Started, Connecting the Dot Pad, New Map, New Pin, Edit Pin, Display Preferences, Automatic Simplification, Map Customization, My Archives, Login / Logout, Release Notes) are brief prose only, no table — Connecting the Dot Pad additionally includes a numbered step-by-step (power on the device, press Connect Dot Pad, Shift-Tab twice to the browser's device picker, arrow down to the device, Enter to connect).

Content lives in its own file, `help-content.html`, fetched and injected into the dialog on first open (cached after that — later opens reuse the fetched copy rather than re-fetching), so the help text itself can be hand-edited without touching `index.html` or `app.js`. The file is a bare HTML fragment (`<h4>`/`<p>`/`<table>`/`<ol>` only, no `<html>`/`<head>`/`<body>` wrapper) meant to be dropped into the dialog's content container via `innerHTML`.

## Release Notes

"Release Notes" (in the [Main Menu](#main-menu), immediately after Help) opens a dialog listing user-facing changes, newest first, so users can see what's changed since they last checked. No hotkey — a Close button at the top mirrors the Help dialog's own layout.

Same fetch-once-and-cache pattern as Help: content lives in its own file, `release-notes.html` — a bare HTML fragment (`<h4>` per dated entry, `<ul>`/`<li>` for the changes under it), fetched and injected into the dialog on first open and cached after that. Only genuinely user-facing changes belong here — internal refactors, spec-doc edits, and work on the `experimenthw` sandbox don't get an entry. Whenever a new keyboard hotkey or Dot Pad key combo is mentioned, the exact key/combo is spelled out inline (matching how the [Command / hotkey mapping](#command--hotkey-mapping) table itself documents them) rather than described only in prose. A setting mentioned in an entry (e.g. Cursor Solo Timeout) also notes where it lives in Display Preferences and what its full range of values does, not just that it exists.

### SVG Display Requirements

* Use SVG to manage all segments and pins.
* The full canvas is in the ratio 3x2 to conform to the Dot Pad dimensions. Canvas dimensions change if braille labels are being used.
* Braille labels also stay a fixed size regardless of scale/zoom.
* Street segments are open lines.
* Every pin marker — anchor and additional alike — is a solid 3x3-dot square. It does not resize with map scale. Although the marker has visual size and shape, it is treated as a point object in the SVG, not a shape.
* Line objects can have a line style of solid, dotted, or dashed (as yet unimplemented). These line types may be used to differentiate different types of roadway or pedestrian path. Solid is the default: densely packed dots on the display. Dotted skips approximately every other dot of the solid line; dashed skips approximately every third dot of the solid line (exceptions are OK provided the majority of the line conforms).
* The cursor is a 4x4 open circle (an open square with corner dots removed).

### Cursor and hit testing

The cursor is a small unfilled circle (an open 4x4 square with the corners missing). It can be moved with the arrow keys on the keyboard, or with dots 3, 2, 5, and 6 on the device (corresponding to left, up, down, and right respectively). The cursor moves one display pixel per key press.

If the cursor is at the edge of the current view, moving it further in that direction pans the map instead of stopping — including "Edge of Map" if the fetched data's own boundary is reached.

Any object that intersects with the edge of the circle is considered "current." If more than one object intersects the edge, there is more than one current object. Current objects are identified by name.

Current object names are displayed in the message field and on the message display. If nothing is current, the message display is simply blanked — no "no street" or similar placeholder text, since an absence isn't worth interrupting/re-announcing over, especially while sweeping the cursor across open space between features.

When multiple objects are current, we display only unique names: if several current objects share the same name, we display that name once. Names are run through [feature name compacting](#feature-name-compacting) before display, same as braille labels — this applies uniformly to streets and pins alike, though for pins specifically the name is already compacted once, at creation time (see [Pins](#pins)), rather than re-compacted here on every cursor move; a freeform name with no recognized type or ordinal word just passes through unchanged either way. 

* If there is exactly one current object, the message display shows its compacted stem and type together, e.g. "9th St." or "Sacramento St."
* If there are multiple current objects, only the compacted stem of each is shown (no type), sorted alphabetically and joined by the word "and" — e.g. two current objects "Main Street" and "Spruce Street" always show as "Main and Spruce," never "Spruce and Main," regardless of which one the hit-test scan happens to reach first. This matters in practice: without the sort, the exact same pair of objects could re-announce itself with the names in the opposite order a pixel or two later as the cursor sweeps through an intersection, reading as two different reports for what's actually one unchanged situation. Dropping the type also keeps multi-name messages from growing unwieldy when several features are packed under the cursor at once.

## Scale and Map Filtering
    
### Scale behavior

The scale appears on the screen as a combo box showing the value of the current scale.

* Scale values are always "X = Y," where X is the distance on the display and Y is the distance on the map. For example, "1 in = 300 ft" or "1 cm = 300 m." 
* Whenever the scale is adjusted, the new scale appears on the message display.

### Street importance tiers

Each way is tagged with a fixed tier from its `highway` class at fetch time (not recomputed on pan/zoom):

| Tier | Highway classes |
|---|---|
| 1 | motorway, trunk |
| 2 | primary |
| 3 | secondary |
| 4 | tertiary |
| 5 | unclassified, residential, living_street |
| 6 | service |
| 7 | footway, path, cycleway, pedestrian, steps |

Pins are never tiered. Tiers are purely data — nothing hides a tier automatically. They exist to drive the Map Complexity filter (see [Editing the Map](#editing-the-map)) and, later, street-label placement priority (see [Label placement](#label-placement)).

### Map filtering

Streets and pins are fetched as-is from Overpass, with no automated cleanup, deduplication, or geometric simplification applied. Per-item show/hide (Visible Streets, Pins, and the shared Hidden Features list, via the Edit Map dialog — see [Editing the Map](#editing-the-map)) is always manual. The Map Complexity tier-cutoff itself can additionally be driven automatically by [Automatic Simplification](#automatic-simplification) (on by default, toggleable in Settings) — a manual Map Complexity pick still always takes effect immediately, but automatic adjustment may change it again the next time it runs.

## Pan Behavior

Two ways to pan, both calling the same `panMap(direction)`: Ctrl+arrow (see [command mapping](#command--hotkey-mapping)) is the keyboard/screen-reader path, and a mouse-only visual affordance — a subtle bar along the middle of each edge of the map, brightening on hover, click to pan one step in that direction — is the pointer path. There used to be an on-screen "Move Map" button group serving both purposes; it was replaced by the edge bars specifically because a button group is screen-reader clutter *and* an unintuitive target for a sighted mouse user, when the actual affordance people reach for is "grab the edge of the map." The edge bars are deliberately excluded from the accessibility tree (`aria-hidden`, no `tabindex`/role, plus `#map`'s own `role="img"` already collapsing its children) — they exist only for pointer users; Ctrl+arrow remains the sole path for keyboard/screen-reader panning and is unaffected by any of this.

Either way, the display moves in the specified direction by the amount specified in Pan Amount (settings) — or as far as it can if less room than that remains before the edge of the fetched data, rather than not moving at all (a pan is only ever a no-op once the view is genuinely already at the edge). The tactile display updates and the on-screen Pan Status announces "[distance] [direction] of [anchor pin]," following the [message display architecture](#message-display-architecture) (message field updates first, then pushes to the Dot Pad and triggers speech).

Once the view is actually at the edge of the fetched data — the square region bounded by the pin distance threshold from the anchor pin, see [Data sources](#data-sources) — a further pan in that direction is rejected: a tone plays (see [Sound cues](#sound-cues)) and the message display reports "Edge of Map."

Anything that changes how much real-world area the view currently covers without itself being a pan — toggling a label zone, changing Scale, switching Units — re-clamps the view back within the fetched data immediately, rather than leaving it at a position that was only valid for the *previous* view size until some later pan happened to correct it. Before this, that stale-position gap was the actual cause of an apparent "panning irregularity" (issue #16): toggling a label zone off after panning to the edge with it on could leave the view sitting slightly past where the now-larger view was allowed to be, so the next pan — even in the same direction just pressed — would visibly snap backward to fix that, rather than continuing to move the requested way.

If changing scale would leave the cursor outside the new view, the view shifts to keep the cursor visible, bounded by the edge of the fetched data. If the data doesn't allow enough room, the cursor's on-screen position is clamped to the edge instead.

If a pan would leave the cursor outside the view on the edge opposite the pan direction, the cursor moves with the pan by the same amount, keeping its position relative to the view unchanged.

If a pan would leave a pin marker's footprint straddling the boundary between the map and an active label zone — rendering it half in the map, half in the zone — the pan target is nudged by a few pixels along the pan's own axis, just enough to clear the marker to whichever side (fully back inside the map, or fully past the boundary into the zone) is the smaller move. This only applies where a label zone is actually active on that edge; a marker running past the edge of the map on a side with no zone is left alone, since there's no zone for it to visibly invade there.

## New Map / New Pin

Starting a map and adding a pin to one both go through short dialogs rather than an always-visible search field, so the main page stays uncluttered (see `ui-cleanup.md` for the design rationale). Before any map exists, a standalone **New Map** button is the sole entry point, next to instructional text ("To get started, connect your Dot Pad, then use the New Map button to search for any address or location. Try the Help button for more information."). Once an anchor pin exists, that text disappears and the button is replaced by the **Map Menu** — a WAI-ARIA "Actions Menu Button" (same pattern as [Main Menu](#main-menu)) — with two items, **New Map** and **New Pin**, arrow-key navigable. The `new-menu-*` element ids weren't renamed to match "Map Menu" — internal identifiers, not user-facing text, same convention as the POI/Pin rename (see [Additional Pins](#additional-pins)).

The second item is **New Pin** or **Edit Pin**, never both — see [Edit Pin](#edit-pin) below for when and why it switches, and why `p` (and its quiet `a` alias) cover both without a separate hotkey.

Hotkeys: `n` opens **New Map**, always available. `p` opens **New Pin** or **Edit Pin**, whichever applies (documented); `a` does the same thing, kept quietly for muscle memory from before this dialog was renamed from "Drop Pin," but not documented anywhere user-facing. Neither `p` nor `a` do anything before a first map exists — there's no cursor position to drop or edit a pin at yet. Neither New Map nor New Pin has a Dot Pad key combo: both require typing a search string, and text entry isn't possible from the device — the QWERTY keyboard is required either way, so there's nothing for a device-side combo to trigger. Same for Edit Pin, for the same reason (typing a new name).

**New Map** takes a search string and always builds a fresh map centered on the result, discarding whatever map is currently showing (which is archived to Map History first, same as any other anchor replacement — see [Saving and exporting](#saving-and-exporting)) — unlike [Additional Pins](#additional-pins) below, there's no distance check and no "too far" dialog, since replacing the map is the whole point. Field label: "New map location:". Instructional text: "Search for a location. The new map will be centered there." — with "The current map will be added to your history." appended whenever a current map already exists. Buttons: Search (the default, Enter-triggered action) and Cancel.

**New Pin** covers both ways of adding a pin to the current map — dropping a named pin at the cursor, or searching for a location elsewhere on the map — see [Custom Pins](#custom-pins) and [Additional Pins](#additional-pins) below for each. Field label: "Pin Name:". Instructional text: "Name a pin here, or search for a location elsewhere on this map." Buttons: Drop Pin Here (the default, Enter-triggered action — matches this dialog's behavior from before it covered searching too), Search, and Cancel.

Entering a location via either dialog returns a pin (the anchor pin for New Map, an anchor or additional pin for New Pin depending on distance — see [Additional Pins](#additional-pins)) and adds a solid 3x3 square marker to it (see [SVG Display Requirements](#svg-display-requirements)).

### Edit Pin

Opens instead of New Pin — from the Map Menu's second item, or the `p`/`a` hotkeys — whenever the cursor is already on a pin (anchor or additional), per the same cursor hit-test [Cursor and hit testing](#cursor-and-hit-testing) uses to decide what's "current" there. New Pin and Edit Pin are never available at the same time (there either is or isn't a pin under the cursor), so `p`/`a` and the Map Menu's item safely cover both without a separate hotkey or menu entry — the Map Menu's item label and hover text switch between "New Pin"/"Mark a new location on this map." and "Edit Pin"/"Edit the current pin." each time the menu is opened.

Dialog title: "Edit Pin". Field label: "Pin Name:", pre-filled with the pin's current (compacted) name. Instructional text: "To update the pin name, press OK, or press Cancel to leave it unchanged." — with "Pressing 'Delete Pin' will permanently remove this pin from the map." appended whenever the target isn't the anchor. Buttons: OK (the default, Enter-triggered action, hover text "Update pin name"), Cancel (hover text "Leave pin name unchanged"), and — only when the target isn't the anchor — Delete Pin (hover text "Permanently remove pin from map").

**OK** renames the target: the anchor's `lastAnchorName`, or the matching entry in `additionalPois`. The new name is run through [feature name compacting](#feature-name-compacting) the same way every other pin name is at creation time, so a freeform name like "Home" passes through unchanged while an address-like name still gets compacted. A blank name is rejected by the field's own required-field validation, without needing a submit — same as New Pin's name field. Renaming the anchor additionally replaces the H2 heading and the browser tab title with the new name (both otherwise show the fuller geocoded display name — see [Screen Layout](#screen-layout)): the pin name is the single source of truth for how the anchor is presented everywhere, not just in pin navigation.

**Cancel** (or Escape) closes the dialog without changing anything, same as New Pin's own Cancel/Escape behavior.

**Delete Pin** (never shown for the anchor — a map always needs its anchor) permanently removes the target pin from `additionalPois`. This is deliberately different from Edit Map's own pin removal (see [Editing the Map](#editing-the-map)), which only hides a pin — reversible via Hidden Features; Edit Pin's Delete Pin cannot be undone. The cursor stays where it was; only the pin itself is gone.

### Additional Pins

Additional pins can be added to a map via **New Pin**'s Search button (see above). Each new pin gets the same solid 3x3 square marker (see [SVG Display Requirements](#svg-display-requirements)).

Pin names are run through [feature name compacting](#feature-name-compacting) once, at creation time — not left raw and compacted later at each display site. This applies to every way a pin can be created: additional pins added via search, custom pins dropped at the cursor, and the anchor pin itself. The compacted name is what's stored and reused everywhere the pin is later shown or spoken (the internal pin list used for `.`/`,` navigation, cursor hit-test messages, the initial "found it" announcement).

Whether a subsequent pin location joins the current map or requires a new one is a hit-test against the fetched data's actual boundary (`lastBbox`, the same square described under [Data sources](#data-sources)) — not a separate circular distance threshold. (Before issue #15, it was a circle of radius `POI_DISTANCE_THRESHOLD_MILES` from the anchor pin; since that's also the fetched square's half-side, the circle sits fully inscribed inside the square, so this hit-test can only ever admit a location the old check would have rejected, never the reverse — specifically, a location in one of the square's corners, whose data was already fetched and on the map, but that the old check still called "too far.")

If the location falls outside that boundary, a true modal dialog says "The new location is [distance] away from [anchor pin]. That's too far away for a single map." (the distance shown is still the straight-line distance from the anchor, purely informational — it no longer drives the decision itself). Buttons are "Show [new pin]" and "Cancel." If the user selects the new location, the old map is discarded and the new pin becomes the anchor with a new map generated around it.

If the location falls within that boundary, the new pin is added to the current map and the map pans to center that new pin. Panning behavior automatically happens, announcing the distance and direction from the anchor pin. Multiple additional pins can be added to a single map.

As pins are added to the map, the locations are added to an internal list (a hidden `<select>`, `#poi-list` — not shown or reachable in the UI; see below for why). Nothing renders it on screen or in the accessibility tree.

The `.`/`,` hotkeys (dot 4 / dot 1 alone on the Dot Pad — see [command mapping](#command--hotkey-mapping)) step forward/backward through that list, wrapping at either end rather than stopping (advancing past the last entry lands back on the first, and vice versa). This is the only pin-navigation path for keyboard and Dot Pad users.

For sighted mouse users who don't know those hotkeys, a **Goto Pin** button — a pin icon at the bottom center of the map frame — steps forward through the same list (one direction only, no reverse). It's deliberately invisible to assistive tech (`aria-hidden`, not in the tab order): it exists purely as a mouse shortcut for the hotkeys/dot keys above, not an alternate path for screen-reader users.

**Navigating among pins this way announces just the destination pin's name — not a distance/direction from the anchor.** This is deliberately different from an explicit pan or a newly added pin (both of which do announce "[distance] [direction] of [anchor pin]," per [Pan Behavior](#pan-behavior)): moving among pins you already know about is a "go to X" action, where the useful information is which pin you're now at, not how far it is from the anchor.

### Custom Pins

The **New Pin** dialog (see [above](#new-map--new-pin)) drops a custom, user-named pin at the cursor's current position when confirmed with "Drop Pin Here" (or Enter in the field) — the field's default action, unchanged from before this dialog also covered searching. Pressing Escape (or clicking Cancel) closes the dialog without adding anything. A blank name is rejected by the field's own required-field validation, without needing a submit.

**Name suggestions from nearby Google data.** Opening the dialog immediately runs two Google lookups in parallel (this was Overpass originally, switched because the Overpass query was often slow and frequently returned nothing at all for this small a radius): a **Places API (New) nearby search** for named businesses/amenities within a real-world radius of the cursor's current position, plus a **Geocoder reverse lookup** at that same point for the nearest street address — needed because Places' nearby search returns businesses/pins but not bare street addresses. Either lookup failing alone just contributes nothing (the other's results still show); only both failing surfaces as an error. The radius is `CURSOR_HIT_RADIUS` (the same fixed-in-dots value used for street hit-testing, see [Cursor and hit testing](#cursor-and-hit-testing)) converted to real-world feet at the current Scale — it shrinks and grows with zoom, independent of which label zones happen to be active (the dot-to-feet ratio itself doesn't change with zone state, only the total visible area does). The reverse-geocoded address is the nearest address to the point, not necessarily one inside the radius — accepted, since "the closest address to the cursor" is exactly what a user dropping a pin at an unnamed spot wants.

Results are deduplicated and sorted alphabetically — a place's display name for businesses, or "[house number] [street]" for the reverse-geocoded address. The first result populates the edit field automatically as soon as the lookups return, **with the text selected**, so simply starting to type replaces the suggestion rather than appending to it; Up and Down arrow keys step forward/backward through the full result list **without wrapping** (a no-op at either end), each populating the field the same selected way. **If the user starts typing before the lookups return, their text is never clobbered** — the arriving results skip the auto-fill (real typing is detected via the field's `input` event, which programmatic fills never fire) and just sit ready, so the first Down-arrow press afterward starts from the first candidate. A suggestion is purely a naming aid: confirming with OK **always** places the new pin at the cursor's own current position, never at a suggested candidate's own (possibly slightly different) real-world coordinates. If the lookups are still in flight, return zero results, or both fail outright, the dialog shows an appropriate status message ("Loading nearby places…" / "No nearby places found." / "Could not load nearby places.") and the field is left for fully manual entry.

Arrow keys are prevented from moving the map cursor while this dialog is open, via the global hotkey guard that blocks whenever a form control (the edit field, an `INPUT`) has focus.

A custom pin is added through the same path as any other additional pin — it shows up in `.`/`,` pin navigation, the Edit Map dialog's Pins group, on-screen rendering, cursor hit-testing, and the tactile raster exactly like a search-added pin, with the same short-address-style pin conventions (see [Additional Pins](#additional-pins)) except its name is whatever the user typed rather than a geocoded address. Pin names are not required to be unique — this matches every other pin-naming path in the app, none of which enforce it either.

## Editing the Map

Clicking "Customize Map" (in the [Main Menu](#main-menu)) opens a dialog with four expandable, collapsible groups (native disclosure widgets, each with an `<h4>`-wrapped label so the group names stay heading-navigable while expanded): **Pins**, **Visible Streets**, **Hidden Features**, and **Map Complexity**. There is no Save/Cancel step — every action in this dialog takes effect immediately and is reflected on the map, the tactile raster, and the message field right away.

**Pins** lists every pin currently visible on the map, sorted in the same order as the internal pin list used for `.`/`,` navigation (anchor first, then additional pins in the order they were added). Each item is a plain clickable button — clicking a pin removes it from the map (and that internal list) and moves it into Hidden Features. The message field announces "[pin name] removed."

**Visible Streets** lists every street/pathway name currently on the map, alphabetically, regardless of class. Clicking a street removes it from the map at every scale and moves it into Hidden Features. The message field announces "[street name] removed."

**Hidden Features** is a single shared list for everything currently hidden, whether it was a pin or a street — hidden pins are listed first (in Pin list order), hidden streets alphabetically after. Clicking an item here restores it to the map and moves it back to its home group (Pins or Visible Streets). The message field announces "[name] restored."

Focus handling in all three of the above groups follows the same rule: after a click, focus stays in the group the item was just clicked from, landing on whichever item now occupies that same list position (the next item, or the previous one if it was last). Focus only jumps to the other group — landing on that specific item's button — if the group the click came from is now completely empty.

**Map Complexity** is a mutually-exclusive radio group, not a membership list, with four levels from most to least detail: "All streets and pathways," "Simplified neighborhoods" (hides importance tiers 6–7), "Major streets" (hides tiers 5–7), "Major highways" (tier 1 only). Each level is a strict tier cutoff (every level is a subset of the one before it), and it is a completely independent filter from Visible/Hidden Streets — a street hidden by hand stays hidden at every complexity level, and changing complexity never un-hides or re-hides a manually-toggled street. Picking a level announces "[level] visible." in the message field. The 1-4 app hotkeys (see [Command / hotkey mapping](#command--hotkey-mapping)) jump directly to a level without opening the dialog.

## Automatic Simplification

Keeps Map Complexity at a readable level without requiring the user to have full mastery of the manual controls above, while never overriding a manual choice on the spot — see [Settings](#settings) for the "Automatic simplification" checkbox that turns this on and off (on by default).

**Density metric:** the percentage of raised pixels within the map's own drawable region (the same effective area described in [Label placement](#label-placement), which shrinks when a label zone is active) out of every pixel in that region. The count doesn't distinguish streets from pins or the cursor — all of it counts as "ink" — and always excludes braille label zone pixels, since those live outside the drawable region by construction. **The critical value is 35%** — a reading at or below 35% counts as fitting, only a reading *above* 35% counts as too dense.

**When this runs:** a new anchor search (evaluated once, at the default scale, before the very first render); a scale change (the `[`/`]` keys, their Dot Pad combos, or the Scale control in Display Preferences); a Units change (Imperial/Metric — it re-renders the map at a new effective real-world footprint for the same scale index, which can change density even though the scale index itself didn't move); and checking the "Automatic simplification" setting on (evaluated immediately at whatever scale is currently showing). It does **not** run on panning, on manually hiding/showing individual streets or pins via Edit Map, on toggling braille label zones, or on manually picking a Map Complexity level — a manual pick takes effect immediately and is never reverted on the spot; the next time one of the triggers above fires, it re-evaluates fresh from whatever level is currently active (which might be that manual pick, or might not, depending what happens next) and may change it again. It's skipped entirely while Cursor Only mode is active (density reads near-zero with everything hidden, not a meaningful reading) — whatever level is active stays frozen until a trigger fires outside Cursor Only mode.

**Algorithm:** density is monotonic in Map Complexity index — each level's visible streets are a strict subset of the level before it (see Map Complexity above) — so one rule covers both directions:
* If density at the currently-active level exceeds 35%, step toward *more* simplification one level at a time, re-checking density after each step, until density no longer exceeds 35% or the next candidate level would leave literally no street visible in the **current viewport** specifically (not just "no street anywhere in the whole fetched square" — a tier cutoff can be non-empty overall but empty in what's actually panned into view). In that case, the last level that still showed a street is kept, even though it exceeds 35% — "Major highways" itself, if reached and still over 35% but showing at least one street, is simply the final answer, since there's nowhere higher to escalate to.
* If density at the currently-active level does not exceed 35%, try stepping toward *less* simplification (more detail) one level at a time, re-checking density after each step, continuing as long as each candidate still doesn't exceed 35%. Stop at the first candidate that would exceed it (keeping the last one that didn't), or upon reaching "All streets and pathways."

**Feedback:** when a trigger actually changes the active level, the standard `"[level] visible."` announcement (the same wording a manual change already uses) is appended to whatever message that trigger already shows — e.g. `"1 in = 500 ft. Simplified neighborhoods visible."` for a scale change, or `"Units: Metric. Major streets visible."` for a Units change. If nothing changes (density already fits, the setting is off, Cursor Only mode is active, or no map is loaded), the trigger's normal message shows with nothing appended, exactly as before this feature existed.

## Street Abbreviation Key

Opens via `/` on the keyboard or dots 3+4 on the Dot Pad (see [Command / hotkey mapping](#command--hotkey-mapping)) — a modal dialog listing every pin and street actually visible right now, so a user who doesn't recognize a street's 3-character braille label can look up what it stands for without hunting for it with the cursor. Addresses [Issue #1](https://github.com/touchout-org/tmap/issues/1). "Visible" here means the same three filters the map itself already applies: the current viewport (pan/zoom), Map Complexity, and Hidden Features — not the full fetched square.

Pins are listed first (same order as `.`/`,` pin navigation), each showing the same solid 3x3 marker used on the map in place of a label, since a pin never gets one. Streets follow alphabetically by their compacted display name (see [Feature name compacting](#feature-name-compacting)), each paired with the exact 3-character label the map's own tactile labels use (see [Label creation](#label-creation)) — computed via the same `assignBrailleLabels` call the map's label placement uses, so this list's labels can never disagree with what's actually labeled on the map. Each line reads `[abbreviation]--[name]`, no spaces around the dashes. If nothing is currently visible (cursor-only mode, or a Map Complexity level that hides everything), the dialog shows "No streets or Pins are currently visible." instead of an empty list.

The on-screen list itself is plain and fully visible — ordinary scrolling and screen-reader reading, no pagination. The same content is **also** rendered as real braille directly on the graphics display, temporarily replacing the map (never overwriting or altering the map data itself): up to 8 lines of 20 characters each per screen, word-wrapped at whitespace with a 3-character indent on any continuation line. A street's label is always raw 8-dot computer braille (NABCC), matching the map's own labels — never re-translated under the current Braille Translation setting; the name after it is translated under whichever setting is currently active, the same as the message display. Dots 4+5+6 / 1+2+3 (reusing the message window's own combos) page one full screen forward/backward while the dialog is open. The tactile side alone additionally shows 3 usage hints at the very top, indented the same way a continuation line is: "123 scrolls up", "456 scrolls down", "All keys exits."

Escape (keyboard) or dots 1+2+3+4+5+6 (Dot Pad) close the dialog and re-send the current map to the device, leaving it exactly as it was before the dialog opened. While the dialog is open, every other keyboard/Dot Pad hotkey is suppressed, since the underlying map can't be changed out from under the list.

## Braille Resources

### Representing braille on the Dot Pad

Modules for turning text into braille and for reading from the Dot Pad keys are shared across this app's braille handling.

### Braille labels

Braille labels can be shown on the graphics pad along the top, bottom, left, and/or right edges of the display, toggled independently via four checkboxes (see [Settings](#settings)). The presence or absence of each label zone changes the SVG viewbox's size and position — see [Label placement](#label-placement) for the exact dot-column/row math. Label content — which streets get labeled and where, abbreviation collision handling, the oblique-angle rule, the overflow rule, and the actual braille-dot rendering into the zones on both the on-screen SVG and the tactile raster — is described below.

#### Feature name compacting

A general-purpose utility, not specific to braille — it also feeds the planned SVG export's per-street metadata (see [Saving and exporting](#saving-and-exporting)). OSM's `name` tag is consistently the fully-expanded, non-abbreviated form of a street name (confirmed empirically). Name compacting is done directly from `name` with two purpose-built lookups.

Takes a street name, returns `{ stem, type }`. Every word is classified first (`classifyNameWords` — a shared building block, not specific to this function alone) as **direction** (matches a compass-direction word, any position in the name — not just a leading prefix), **type** (the first word, scanning left to right, that matches a known street-type word — only one word per name is ever classified this way, even if a same-shaped word appears again later), or **stem** (everything else):

1. **Direction words** — every word classified `direction` (North, Northeast, East, Southeast, South, Southwest, West, Northwest) is abbreviated to its standard short form, always with a trailing period (N., NE., E., SE., S., SW., W., NW.), wherever it sits in the name — issue #18: a leading *or* trailing direction word both compact, not just a leading one.
2. **Type suffix** — the word classified `type` (if any) is abbreviated to its standard form (St., Ave, Blvd, Dr, Rd, Ln, Ct, Cir, Pl, Ter, Way, Hwy, and similar) wherever it sits in the name, not just at the end. The stem/type split happens right *before* that word: `stem` is every word before it (direction-abbreviated, joined), `type` is that word's abbreviation plus everything after it (also issue #18 — a trailing direction suffix stays grouped with `type`, not `stem`). Example: "South 21st Avenue Northeast" → `stem` "S. 21st", `type` "Ave NE.".
3. **No type word, or nothing before it** — if no word matches a street type, or the type word has no `stem`-classified word before it (e.g. "Avenue of the Americas", or direction-prefixed "Southeast Avenue of the Americas" → "SE. Ave of the Americas") — the type word is still abbreviated in place, but the whole name is returned as one undivided `stem` (`type` empty). There's no meaningful stem-prefix/type-suffix structure to split there; the type word is really just part of the proper name.
4. **Ordinal numbers** — independently of the above, any ordinal number word found within the final `stem` (First through at least the 90s, including compounds like "Twenty-First") is converted to its digit+suffix form (Ninth -> 9th, Twenty-First -> 21st). If none is found, `stem` is left as-is.

Every step degrades gracefully: a name with none of direction words, a recognized type suffix, or an ordinal word passes through completely unchanged (`stem` = the full name, `type` = empty) — nothing regresses for names this can't help with.

**Feeds directly into [Label creation](#label-creation) below and into [cursor hit-test messages](#cursor-and-hit-testing).** The two consumers join `stem` and `type` differently, deliberately: hit-test messages for a single current object space-join them ("9th" + " " + "St" -> "9th St"), so the vowel-stripping-style word logic that could apply to a spoken/brailled message never spuriously merges the boundary. Label creation instead concatenates them directly with no space, specifically so a doubled letter at that boundary collapses like any other doubled letter rather than being protected — see Label creation's own steps for the full reasoning.

#### Label creation

All labels are unique 3-character abbreviations created from the compacted street name (see [Feature name compacting](#feature-name-compacting) above). No two streets on the map, even if they're not both being displayed currently, may have the same abbreviation. Labels are always in lowercase 8-dot computer braille, and only include alphanumerics — no punctuation except for a dash if necessary. The 3-character limit is hard and fast, no exceptions; if necessary, pad the end of the label with dashes.

The abbreviation algorithm goes like this:

1. Take the compacted name's stem and type separately (see [Feature name compacting](#feature-name-compacting) above — direction words and the street type are already abbreviated there, wherever they sat in the original name, not just leading/trailing).
2. Strip vowels from the stem, one word at a time, except: a single-letter vowel word (such as "A" or "E."); a direction-abbreviation word (already protected the same way — e.g. "NE." keeps its E so it stays distinct from "N."); or the stem's own real first word — skipping past a leading direction abbreviation if it has one — which always keeps its own leading letter regardless of vowel status. This last exemption is what makes "Elm Street" label as "elm" instead of losing the E entirely: the street's actual identifying word is always recognizable by its first letter, even though every other vowel in the name is still stripped as usual.
3. Strip vowels from the type the same way (single-letter and direction-abbreviation words still kept whole), but with **no** leading-letter exemption — a type abbreviation's own first letter is never specially protected. "Avenue"'s abbreviated "Ave" still loses its A: "Elm Avenue" -> stem keeps Elm's E, type still loses Ave's A, giving "elmv" — not "lmv" (the old behavior, before this exemption existed) and not "elmav" (over-protecting a word that isn't the street's real identifying name).
4. Concatenate the (now independently stripped) stem and type directly — no space at the join, unlike the space-joined form used for cursor hit-test messages. Any internal spaces the stem itself still has (e.g. "Santa Fe") remain at this point; only the stem/type boundary itself loses its separator.
5. Strip all remaining spaces and punctuation, collapsing the name to one continuous string.
6. Collapse every run of 2 or more identical letters (case-insensitive) down to a single occurrence, anywhere in the string — including right at the former stem/type boundary, now that concatenation in step 4 no longer protects it. This is deliberate: a doubled letter there is exactly as wasteful a phonetic cue as a doubled letter anywhere else in the name. Runs of the same *digit* are exempt and always left alone — the "11" in "11th" is real information, not a doubled-letter artifact.
7. Make all letters lowercase.
8. **Digit-anchored labels.** Numbered streets (after [Feature name compacting](#feature-name-compacting)'s ordinal conversion) are common enough, and their digits meaningful enough, that a generic character-window walk over them is exactly the kind of arbitrary, hard-to-interpret result this whole algorithm is meant to avoid — keeping the actual number visible in the label is far more useful than any incidental 3-character window of the surrounding letters. If the string contains a run of 2 or more consecutive digits (there's at most one — ordinal conversion only ever produces a single digit run per name, and neither direction nor street-type abbreviations introduce digits), try a label anchored on those digits before falling through to step 9:
   * Exactly 2 digits: the pair itself is the anchor.
   * 3 or more digits: try the rightmost 3 digits alone, with no letter at all — e.g. "West 130th Street" -> "130". If that's already taken, drop to the rightmost 2 digits and use them as the anchor instead.
   * With a 2-digit anchor (either case above): complete it into 3 characters by adding exactly one adjacent letter from the surrounding string. Try leading characters first, walking forward — left to right, from the very start of the string toward the digits, so the earliest and most identifying characters are tried before whatever happens to sit immediately next to the number. Only once every leading character is exhausted does the search move to trailing characters, nearest-first. (Real example: two ways at the same numbered cross street, distinguished only by an "(upper)"/"(lower)" suffix on one of them — "West 134th Street" claims the bare number "134" first; "West 134th Street (upper)" then drops to the rightmost 2 digits and finds "w34" on its very first leading-letter attempt, from the direction-abbreviated "w" at the start of its own string.)
   * If every digit-anchored attempt collides — or the string has 0 or 1 digits, in which case this step doesn't apply at all — fall through to step 9.
9. Take the first three characters of the string and check for uniqueness.
10. If not unique, keep the first two characters fixed and walk the third character forward through the rest of the string, one character at a time, until a unique 3-character abbreviation is found. This is a deliberate choice, confirmed against real examples during implementation: keeping the shared prefix intact and varying only the one character that actually needs to differ keeps related street names (e.g. "University Avenue"/"University Drive"/"University House Way", or "Virginia Gardens"/"Virginia Street") looking and feeling similar, rather than sliding the whole 3-character window to a different, unrelated-looking stretch of the name.
11. If step 10 exhausts the string without finding a unique label, try a different anchor: keep the first and last characters fixed and walk the *middle* character forward through the string's interior characters instead.
12. If step 11 exhausts the string too, keep the first two characters fixed and try single digits 0-9 as the third character instead.

#### Label placement

The Labels dialog has 4 checkboxes to place labels at the top, bottom, left, and/or right of the display. These label regions are like windows adjacent to the SVG viewbox. Wherever a street intersects an active edge of the viewbox is a possible label point, subject to the rules below.

**Some streets will not get a label — that's an accepted outcome of the algorithm below, not an error state.** There is no "some streets not labeled" indicator; a street that doesn't fit is simply omitted.

**Rules:**

* Labels must always be centered, either vertically or horizontally, on the point where the street intersects the closest active edge.
* Street label priority uses the same [street importance tiers](#street-importance-tiers) established for large-scale decluttering (motorway/trunk highest, standalone footway/path lowest) as the primary sort. Within a tier, the street with more visible segments on the current display wins — a rough proxy for how substantial a street actually is on screen right now, since a real through-street naturally accumulates more OSM way-segments (split at every intersection) than a short stub does. Position along the edge (left-to-right / top-to-bottom) is the final, deterministic tie-break when tier and segment count both match.
* Labels should only be applied to streets that intersect the active edge at more than 45 degrees. A street that intersects at 45 degrees or less never gets a label on that edge — it's likely to cross an adjacent edge at a more oblique angle, where a label is more appropriate.
* There must be at least 2 display-pixels of whitespace between a label and the map, and between adjacent labels. The map-side padding is the fixed 2-dot-column/2-dot-row figure already built into the zone-sizing math below; between two *adjacent labels*, the 2-pixel gap is measured from the edge of one label's actual rendered content to the edge of the next -- 8 dots wide for a top/bottom label (2 dot-columns/character x 3 + 1-dot kerning x 2, the same figure the zone-sizing math below derives), 3 dots tall for a left/right one (just the braille dot rows, no padding) -- not from the wider zone-depth figure (10/5 dots), which already has the map-side padding baked in and would otherwise double-count it as inter-label spacing too.
* The four corners are shared, contested space between the two zones that meet there (e.g. the top-right corner is shared by the top and right zones), not owned outright by either one -- part of the "no wasted space" principle behind this whole algorithm. Each corner holds exactly one label's worth of physical room. Whichever of the two zones is processed first in edge order (see the placement algorithm below) gets first claim on a shared corner if it has a candidate that needs it; if that zone doesn't need the corner, the other zone sharing it is free to use it instead. A corner is only real, physical room when *both* contributing zones are active — with either one off, there's no gap there to share.

**Placement algorithm**, run after the map and its streets are otherwise finalized for the current view:

1. Process the four active edges in a fixed order: top, right, bottom, left. An edge the user has turned off via its checkbox is skipped entirely.
2. Within each edge, walk street-importance tiers from most to least important. Within a tier, place candidate labels ordered by visible segment count (more wins), then by position — left-to-right along the top/bottom edges, top-to-bottom along the left/right edges — as the final, deterministic tie-break.
3. A candidate is skipped on this edge if it can't fit — it violates the angle rule above, or the 2-pixel whitespace rule against the map, an already-placed label on this edge, or a corner already claimed by the adjacent edge sharing it (see the corner-sharing rule above).
4. A street already labeled on an earlier-processed edge is skipped on every later edge — the primary pass gives each street at most one label, on whichever eligible edge is processed first.
5. **Final pass:** once all four edges have been walked once, make one more pass around them in the same order, filling any leftover room. This pass isn't limited to duplicating existing labels — it can also give a first label to a street that was skipped everywhere in the primary pass. Any candidate that fits the remaining space is eligible, still worked in tier and segment-count order.

Since all labels are exactly 3 characters, the left and right label columns need exactly 10 dot columns each: 2 dot columns per character x 3 characters = 6, plus 1 column of kerning between characters 1–2 and 2–3 = 2, plus 2 dot columns of padding between the label and the viewbox = 10 total. The horizontal labels at top and bottom need exactly 5 dot rows: 3 for the braille dots, plus 2 for the padding between the text and the graphic.

When any of the left, right, top, or bottom labels are turned off, the viewbox expands to use that space for the map.

**Rendering differs between the on-screen SVG and the tactile raster sent to the Dot Pad.** The physical device always receives real 8-dot computer braille, per the label-creation/placement design above. The on-screen SVG instead shows each label as plain print text, positioned within the same footprint the braille block would occupy — so a sighted person looking at the screen and a blind person feeling the Dot Pad can discuss the same map using the same labels, each in the form that's actually readable to them.

### Braille translator

Implemented as `braille-ueb.js`, a standalone module used only by the message display — street labels always render as 8-dot computer braille via NABCC regardless of this setting (see [Rendering differs between the on-screen SVG and the tactile raster](#label-placement) above), since they're a separate rendering pipeline with its own uniqueness/collision requirements that has nothing to do with literary braille codes.

**Data source:** [liblouis](https://github.com/liblouis/liblouis) (LGPL 2.1+), the most widely used open-source braille translator. Rather than vendoring liblouis itself or reimplementing its general-purpose translation engine, the specific data DotTMAP needs was hand-extracted from three of its table files:

* `tables/latinLetterDef6Dots.uti` — the 26 lowercase letter dot patterns.
* `tables/en-ueb-chardefs.uti` — digit shapes (the `litdigit` opcode — the classic a-through-j-shaped numeric forms used after the number sign, not the differently-shaped `digit` opcode, which liblouis uses for an unrelated purpose), the number sign, the capital sign, and the handful of punctuation marks this app's own message-display text actually uses (space, `. , ' - … : & = ! ?`).
* `tables/en-ueb-g2.ctb` — Grade 2 contractions, filtered down to the subset expressible as a pure word-position rule (liblouis opcodes `always`/`word`/`begword`/`endword`/`midword`/`midendword`/`sufword`) rather than its context-dependent `match`-opcode rules (regex-like lookaround/quote/emphasis handling this app's plain message text never needs) — plus the 23 "alphabetic wordsigns" (as, but, can, do, every, from, go, have, it, just, knowledge, like, more, not, people, quite, rather, so, that, us, very, will, you), pulled in via their simpler back-translation-only counterparts since they're too common/valuable to drop. liblouis's `nofor`-prefixed lines (back-translation only) are otherwise excluded, since this app only translates forward (print to braille) — **except** where a `nofor` line's own text+position+dots also matches some `match`-opcode line elsewhere in the table: that agreement confirms the contraction is used for forward translation too, just expressed via `match`, so it's recovered using the position liblouis's own `nofor` declaration names. This cross-reference is shape-agnostic — it doesn't require parsing `match`'s pre/post pattern syntax — and is how `in`, `en`, `ing`, `tion`, `ment`, `ness`, `ance`, `ence`, `ful`, `ity`, `less`, `ong`, `ound`, `ount`, `sion`, `there`, `those`, and `bb` (a doubled-letter sign that only applies strictly between other letters) are included. liblouis's own `match` rules for these do encode one further restriction the position-only extraction doesn't capture — most won't fire when the contraction would be a standalone word by itself with nothing else attached (e.g. the literal text "en" on its own) — accepted as a deliberate simplification, since none of these letter groups are real standalone English words that could plausibly appear alone in this app's actual message text.
* A separate, larger category liblouis calls "short-form words" — common whole words (e.g. "about," "after," "him," "his," "out," "said," "such," "your," and hundreds more, many of them longer compound words) that get their own contracted spelling — is not currently included: several hundred entries, a bigger scope decision than the general contractions above, deferred pending whether it's worth the added table size for this app's actual content.

**Capitalization (both grades):** examined once per word, on the word's original case-preserved text, not per letter. A word with 2 or more letters where *every* letter is capitalized gets the UEB capsword indicator — a doubled capital sign (dots 6,6) once at the front — rather than a separate capital sign before each letter (e.g. "ELM" → dots 6,6 then plain `e`/`l`/`m`). A word with just its first letter capitalized gets a single leading capital sign, same as before. An all-lowercase word gets neither. This app's message text is always plain title-case, ALL CAPS, or lowercase — never irregular mixed case within a word — so this whole-word-pattern approach is correct and sufficient; it isn't a full implementation of UEB's per-letter capitalization rules for arbitrary mixed-case text. A standalone single capital letter (see the letter sign, below) is a separate case and never gets the doubled sign, only a single one.

**Grade 1 (uncontracted)** handles capitalization, numbers, and punctuation, with no contractions at all: each letter maps directly to its dot pattern; a run of digits is preceded by the number sign (dots 3-4-5-6) and each digit uses its literary (`litdigit`) shape; unmapped characters fall back to a blank cell rather than erroring. Grade 1 never needs the letter sign below — with no contractions, a lone letter is never ambiguous with anything.

**Grade 2 (contracted)** builds on Grade 1: text is split into words (letter runs), numbers, and other characters (space/punctuation), each handled independently. Within a word, contractions are resolved **longest-match-first**: at each position, the longest candidate substring whose word-position rule is satisfied (whole word, word-initial, word-final, mid-word only, etc.) wins; if nothing matches at a position, that one character falls back to its plain Grade 1 letter. A small number of contraction entries carry no dot pattern at all (liblouis's `=` value) — these are specific-word overrides that force plain spelling to suppress a contraction that would otherwise misfire (e.g. certain "co-" prefixed words where the generic "co" sign is wrong for that particular word); the translator honors these by spelling just the overridden substring in plain letters, same as any other unmatched position.

**Letter sign (Grade 2 only):** a standalone single-letter word (e.g. a lettered grid street like "B Street") with no contraction of its own falls through to its plain letter cell — but for the letters that also serve as one of the 23 alphabetic wordsigns above, that plain cell is the *same* dot pattern as the wordsign's whole-word contraction (that's the whole mnemonic behind wordsigns — letter b's own shape doubles as "but," etc.). A **capitalized** standalone letter is ambiguous with that wordsign unless marked otherwise: dots 5,6 (the UEB letter sign), then the capital sign, then the letter — e.g. a standalone capital "B" is `letter sign, capital sign, b`, distinguishing it from the wordsign "but." A **lowercase** standalone letter gets no such signal (matching real UEB — the ambiguity there is inherent and left to context, same as liblouis's own back-translation would produce). Derived directly from the wordsign table itself (which letters' shapes are actually reused as a wordsign), not a separate hand-maintained list. Three letters — a, i, o — have no wordsign assigned to their shape at all, since each is already a genuine one-letter English word on its own ("a," "I," "o"); a standalone capital A, I, or O is therefore never ambiguous with anything and never gets the letter sign.

## Settings

Default values in [brackets].

The Settings dialog (opened via "Display Preferences" in the [Main Menu](#main-menu)) follows the same pattern as Customize Map: fully live-apply, no Save/Cancel step. **Every control in this dialog applies immediately on change** — there is no staging, no commit step, and nothing to discard. Opening the dialog only syncs each control's displayed value/checked state to match current app state. The dialog has a single **Done** button that just closes it; there is no OK or Cancel, since a change already took effect the moment it was made.

**Persists across sessions:** Braille Translation, the four label-zone checkboxes, Units, Pan Amount, Cursor Solo Timeout, and Automatic simplification are all saved to `localStorage` on every change and restored on page load, independent of sign-in (see [Accounts and Data](#accounts-and-data) § Local development and testing) — a page reload or a fresh visit picks up right where the last one left off. **Scale is deliberately excluded**: it already resets to `DEFAULT_SCALE_INDEX` on every new anchor search regardless of any prior value (see [Scale behavior](#scale-behavior)), so persisting it would load correctly and then silently get overwritten the instant a search happens. A malformed or corrupted stored value for any field is validated per-field on load and falls back to that field's normal built-in default.

The dialog is organized into sub-sections, each under its own heading:

* **"Braille Options" heading**:
    * Braille Translation: 8-dot computer braille, English Uncontracted, [English Contracted] — live-apply. Only affects the message display; see [Braille translator](#braille-translator) above for what each option actually does and where the data comes from.
    * The 4 label-position checkboxes (left, right, top, bottom — [none checked]). Live-apply, same as Braille Translation above.
* **"Distance and Scale" heading**:
    * Units: Metric / [Imperial] — live-apply. Affects both the Scale control immediately below and every place a distance from the anchor pin is reported (explicit panning, panning to a newly added pin, and the "too far for one map" prompt — see [Pan Behavior](#pan-behavior) and [Additional Pins](#additional-pins)):
        * **Imperial** uses inches (scale), feet, and miles: distances are reported in feet up to 1000 ft, then in miles (rounded to the nearest tenth) beyond that.
        * **Metric** uses centimeters (scale), meters, and kilometers: distances are reported in meters up to 500 m, then in kilometers (rounded to the nearest tenth) beyond that.
    * Scale: live-apply, same as every other control in this dialog. Presets switch between two 9-entry ladders depending on Units:
        * **Imperial**: 1 in = 100, 200, 300, [400], 500, 1000, 1500, 2000, 5000 ft.
        * **Metric**: 1 cm = 10, 25, 35, [50], 60, 120, 180, 250, 600 m — the closest clean round numbers to each Imperial preset's actual real-world footprint (accounting for the fixed inch-to-cm ratio of the physical display, not a naive number-for-number conversion). The two ladders are independent round-number sets, not exact conversions of each other: the same preset index can describe a slightly different real-world map footprint depending on which unit system is active, and switching Units while a map is showing re-renders it at the new effective footprint for the current preset index.
    * Pan Amount: [1/4], 1/2, 3/4, 1 — live-apply. A single value shared by both horizontal and vertical pans, in units of the **current viewbox's** width/height — not the fixed physical display. Since active label zones shrink the viewbox (see [Braille labels](#braille-labels)), the real-world distance covered by a pan shrinks right along with it: e.g. with the Top zone active (reducing the display's usable height), a vertical pan covers proportionally less real-world distance than with no zones active, at the same Pan Amount and Scale setting. The actual real-world distance also varies with the current Scale. Changing it announces "Pan amount: [value]" through the message field; takes effect on the next pan, nothing on screen changes immediately.
    * Pin distance threshold: [1 mile], 2 miles, 3 miles — not yet implemented.
    * Automatic simplification: [checked] — live-apply, same as every other control here. "When checked, smaller streets are automatically hidden or shown depending on map density." Checking it also runs an immediate evaluation at the current scale (see [Automatic Simplification](#automatic-simplification)); unchecking it never changes what's currently displayed, it just stops future automatic adjustments until checked again. Announces "Automatic simplification: on."/"...off." on change, plus the usual level announcement if checking it on changes anything.
* **"Cursor" heading**:
    * Cursor Solo Timeout: 1 sec, [2 sec], 3 sec, 5 sec, None — live-apply, including against an already-running countdown (see [Editing the Map](#editing-the-map) for the cursor-only mode behavior this controls). None disables the auto-revert entirely, leaving cursor-only mode as a manual-toggle-only override, same as before this setting existed.

## Download to Local SVG

"Download SVG" (in the [Main Menu](#main-menu)) saves the current map as a local `.svg` file, immediately, no account and no prior save required — distinct from "My Archives" (see [Saving and exporting](#saving-and-exporting)), which is a full cloud-backed save/load system gated behind sign-in.

### Scope

The export represents the *full fetched extent* around the anchor — the same square region [Data sources](#data-sources) fetches, not the current on-screen pan/scale/viewport. Placement, panning, and scale are all properties of how the map happens to be displayed right now, not properties of the underlying map data, so none of them affect what's in the file:

* **Streets and pathways**: every way not explicitly hidden via [Editing the Map](#editing-the-map)'s Hidden Features list. Map Complexity does **not** filter the export — a street hidden only by the current complexity cutoff is still included, since complexity is a display-time simplification, not a statement about what belongs in the data. (This means the export's own street filter checks only `hiddenStreetNames` — it does not reuse the app's `visibleWays()`, which also applies the Map Complexity tier cutoff.)
* **Pins**: every pin not explicitly hidden (the anchor plus any additional pins), each carrying its name.
* **No label placement, dot patterns, or label-zone geometry** are included at all — a renderer that opens this file later is free to make its own placement decisions for whatever labeling scheme it wants to use, if any. The abbreviated label each street currently resolves to *is* included as metadata (see below) — it's the placement of that label that's excluded, not its existence.

### Coordinate system

The export projects lat/lon the same way the on-screen map does, but scoped to the full fetched square (`lastBbox`) rather than the current viewport, so the file always shows the complete fetched area regardless of whatever's currently panned into view. The canvas is a plain square viewBox in arbitrary round units (`0 0 1000 1000`) — unlike the on-screen SVG, this has no physical Dot Pad audience, so nothing here is tied to the device's dot-grid conventions.

Streets and pins render with simple default styling (thin gray stroke for streets, small dark squares for pins, roughly matching the on-screen look) so the file is directly viewable and useful on its own, not just as a data container for a custom renderer.

### Street metadata

Streets are grouped by the combination of **(name, highway class, tier)** — not by name alone — so a name that legitimately spans more than one highway class or tier (e.g. a mix of residential and footway segments sharing a name) gets a separate group per combination, rather than merging data that doesn't actually describe the same kind of way. Each group is a `<g>` element wrapping that group's polylines, carrying:

* `data-name` — the full OSM `name`, unmodified
* `data-stem` — the compacted stem (see [Feature name compacting](#feature-name-compacting))
* `data-type` — the compacted street-type abbreviation
* `data-label` — the abbreviated label this name currently resolves to via [Label creation](#label-creation)'s algorithm. Uniqueness is computed the same way as always — across every name in the full fetch, not just the exported subset — so this always matches whatever label would actually show on screen or on the Dot Pad if braille labels were turned on right now, even for a street that's otherwise excluded from being labeled today for unrelated reasons (e.g. it lost a placement collision).
* `data-highway` — the raw OSM `highway` tag value
* `data-tier` — the numeric [street importance tier](#street-importance-tiers)

### Pin metadata

Each visible pin is a marker element carrying `data-name` — its name as stored, which is already compacted (see [feature name compacting](#feature-name-compacting)) as of creation time, not the raw geocoded/OSM name. Pins don't get separate compacted stem/type/label metadata beyond that one stored name — they have no highway class or type suffix concept the way a street does.

### File naming

Saved as `[anchor short address].svg` (sanitized for filesystem-safe characters) — the same short-address style already used for spoken/brailled pin references elsewhere in the app (`formatShortAddress`). There's no user-provided "map name" for this quick-download path, unlike My Archives.

## Accounts and Data

### Authentication

Google ID via **Firebase Authentication**, chosen specifically because it's the native path for a Google Sign-In decision already made — no separate OAuth app integration beyond what creating the Firebase project already sets up. "Login"/"Logout" in the Main Menu (Firebase SDK loaded via CDN ES modules, no bundler), using `signInWithPopup`.

### Cloud storage

**Firebase (Firestore + Firebase Authentication).** Chosen because its free "Spark" tier is permanent with no inactivity pause (some alternatives freeze a free project after a week of no database activity — a bad fit for a niche accessibility tool with sporadic usage). Fully managed, no servers to run, and its free-tier ceiling (1 GB Firestore storage, 50k reads / 20k writes / 20k deletes per day, 50k monthly active users on auth) is comfortably oversized for what this app actually stores — small per-user JSON settings and SVG map documents, light traffic.

### Saving and exporting

**The current map lives locally in the browser** (`localStorage`), independent of sign-in — it's not "in" Map History or Saved Maps until one of two things happens to it: a new map replaces it, or the user explicitly saves it. This local copy also survives a page reload, so an in-progress map isn't lost by refreshing.

A current-map record holds exactly what's needed to recreate it: the anchor location (address/lat/lon), additional pins, hidden street/pin names, and the viewport (pan) position. It deliberately excludes anything that's a display preference rather than map data — braille translation, label zone states, Map Complexity, cursor-only mode, and scale are never part of it. Street/way geometry is excluded too; only which streets are hidden is kept, and geometry is always re-fetched live from Overpass against the anchor location when a map is loaded, matching this app's live-data approach elsewhere — at the cost of a reloaded map potentially looking slightly different if the underlying OSM data changed in the meantime, an accepted tradeoff, not treated as a bug.

**Map History (Firestore, `users/{uid}/recentMaps`, requires sign-in)**: whenever the current map is about to be replaced by a new one (a fresh search creating a new anchor), its final state is pushed to the top of Map History — unless it's identical to the entry already on top (e.g. the same location searched again), in which case only that entry's timestamp is refreshed rather than creating a duplicate. Capped at 10 entries, oldest dropped first. Loading a Map History entry never touches the list itself — it only becomes "current" again locally, and only counts as history once *it* is later replaced by something new.

**Saved Maps (Firestore, `users/{uid}/savedMaps`, requires sign-in)**: an explicit snapshot of the current map, taken only when the user presses "Save Current Map." Unlimited, and independent of Map History — saving doesn't touch history, and loading a saved map doesn't touch the saved copy (later changes to the loaded map never write back to it).

The My Archives dialog (Main Menu) has two sections:

* **Saved Maps** — a table (Name, Date/Time, Pins, Hidden Features, Notes, Actions), sortable by clicking the Name or Date/Time column header itself (`aria-sort` on the `<th>` reflects the active column/direction). Each row's Name is a link that loads that map and closes the dialog; each row's Actions menu offers "Edit name/notes…" (reopens the same Name/Notes dialog used to save, pre-filled, and — like the Save dialog — treats Enter in the Notes field as Save rather than a literal newline, Shift+Enter for an actual newline) and "Delete…" (a Yes/Cancel confirmation). A "Save Current Map…" button opens a dialog with Name (pre-filled from the anchor pin) and Notes (blank) fields.
* **Recent Maps** — a table (Name, Date/Time, Pins, Hidden Features) with the current map as its own top row (plain text, not a link, since there's nothing to load) followed by up to 10 Map History entries, each a link that loads that map and closes the dialog. A "Clear History" button empties Map History only.

Both sections show a sign-in prompt in place of their table content while signed out; the current-map row in Recent Maps still works either way, since it's local-only.

### Local development and testing

**The Firebase Local Emulator Suite**, not testing directly against a live free-tier project — matches this project's pattern of never hitting real external services during local dev (see the `USE_LOCAL_TEST_DATA_CACHE` cached-OSM-data approach used for Nominatim/Overpass). Firestore and Auth both run locally via the Firebase CLI, so local test runs never touch production data or require a real Google sign-in. The rest of the app is otherwise zero-build-step, plain HTML/CSS/JS with no Node.js dependency — the Firebase CLI is a deliberate, scoped exception for this one area.

## Other Backlog Items

Known gaps, gathered here in one place so none get lost:

* Line style (solid/dotted/dashed) for street segments — see [SVG Display Requirements](#svg-display-requirements).
* Pin distance threshold setting (currently a fixed constant, not user-adjustable) — see [Settings](#settings).
* Download-from-archive and an unsaved-changes confirmation when loading over unsaved edits — see [Saving and exporting](#saving-and-exporting). Save/load/rename/delete are implemented; these two are not yet.
* liblouis's "short-form words" braille contraction category (several hundred common whole-word contractions, e.g. "about," "said," "your") — see [Braille translator](#braille-translator). Everything else from liblouis's UEB Grade 2 table that this app's plain message text needs is already included.

