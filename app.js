import {
  DotPadSDK,
  DotPadScanner,
  DisplayMode,
  DataCodes
} from './web-sdk-3.0.0/DotPadSDK-3.0.0.js';
import { translateGrade1, translateGrade2 } from './braille-ueb.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signOut,
  onAuthStateChanged,
  connectAuthEmulator
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  getDocs,
  serverTimestamp,
  connectFirestoreEmulator
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

// § Postpass migration dev environment — true only when served from
// touchout.org/tmapdev/, the throwaway clone this migration is being
// built and tested in (see tmapdev.md). Everything derived from this
// (storage keys, buildId) needs zero manual reversion when the finished
// work is merged back into the real tmap repo -- tmap's own deployment
// is never served from /tmapdev/, so this is always false there, and
// this whole file can stay byte-for-byte identical between the two
// repos except for the actual migration changes.
const IS_DEV_BUILD = location.pathname.startsWith('/tmapdev/');

// Data sources — see README.md § Data sources. Geocoding (address -> coordinates)
// is now Google's Geocoder (google.maps.Geocoder) instead of Nominatim, to
// evaluate whether it's more reliable for POI/business-name searches; street
// data is still Overpass.
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// § Analytics — bump this on every deploy so overpassLogs rows (see
// logOverpassQuery) can be correlated with which version of the app
// produced them, e.g. to check whether a later change to fetchWays
// actually improved reliability. Free-form string, not machine-parsed.
// The tmapdev- prefix (see IS_DEV_BUILD above) keeps this migration's own
// test traffic self-evidently separate from real production rows in
// overpassLogs, without anyone needing to remember which dates were dev
// builds.
const BUILD_ID = (IS_DEV_BUILD ? 'tmapdev-' : '') + '2026-07-29';

// Client-side Maps Platform key: not secret -- protected by the API
// restriction (Maps JavaScript API + Places API only) and the website
// restriction (touchout.org/www.touchout.org/localhost/127.0.0.1) set on the
// key itself, not by hiding this. Safe to commit as-is, same trust model as
// the Firebase apiKey below.
const GOOGLE_MAPS_API_KEY = 'AIzaSyDCEb-FQsWaDh4zLI61R_xiELCq76bZKwA';

// § Local test data cache (dev-only, see test-data/README.md) — set to true
// while testing locally to serve cached geocode+Overpass data for the
// addresses below instead of hitting the real Nominatim/Overpass endpoints.
// Avoids the rate-limit/flakiness these two public instances show under
// repeated same-session testing (see project notes). MUST be false before
// every deploy/push -- the dev-cache banner below exists specifically so
// this is impossible to miss in a screenshot before pushing.
const USE_LOCAL_TEST_DATA_CACHE = false;

// § Firebase local emulator (dev-only, see README § Local development and
// testing) — set to true while testing locally to route Auth/Firestore to
// the local Firebase Emulator Suite (`firebase emulators:start --only
// auth,firestore`, run from this repo's root) instead of the real
// dottmap-fire project. MUST be false before every deploy/push -- same
// discipline as USE_LOCAL_TEST_DATA_CACHE above, and the dev-emulator
// banner below exists for the same reason (impossible to miss in a
// screenshot before pushing).
const USE_FIREBASE_EMULATORS = false;

// § Postpass migration (see postpass-migration-spec.md) — which live
// street-data source fetchWays() uses. Default 'overpass' so this is
// mergeable/deployable at any point with zero behavior change; flipping
// this one constant (and redeploying) is the entire rollback surface if
// Postpass ever needs to be backed out once it's live -- see spec §4.5.
const DATA_SOURCE = 'postpass'; // 'overpass' | 'postpass'

// Not secret -- Firestore/Auth access control is enforced by firestore.rules
// and the emulator, not by hiding this. Safe to commit as-is.
const firebaseConfig = {
  apiKey: 'AIzaSyBBVH8u65Rwx1SKJ7eZE6b68BMjuynxPRk',
  authDomain: 'dottmap-fire.firebaseapp.com',
  projectId: 'dottmap-fire',
  storageBucket: 'dottmap-fire.firebasestorage.app',
  messagingSenderId: '236420553583',
  appId: '1:236420553583:web:6bfa15f7f5f615b347669a'
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();
if (USE_FIREBASE_EMULATORS) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
let currentUser = null;

// Maps a normalized ("trim + lowercase") search query to its cached dataset
// file under test-data/. Add an entry (and a matching file, built the same
// way as the existing ones -- see test-data/README.md) whenever a new
// address is needed for repeated local testing.
const LOCAL_TEST_DATA_FILES = {
  // Anchors.
  '2318 fillmore st, san francisco, ca': 'test-data/2318-fillmore-st-san-francisco-ca.json',
  '1516 hearst ave, berkeley, ca': 'test-data/1516-hearst-ave-berkeley-ca.json',
  '2000 university ave, berkeley, ca': 'test-data/2000-university-ave-berkeley-ca.json',
  '261 6th ave, brooklyn, ny': 'test-data/261-6th-ave-brooklyn-ny.json',
  // Standalone anchor, no cached near/too-far POIs -- added specifically for
  // its real numbered "West Nth Street" + direction-word names (Manhattan's
  // West Harlem), useful for label-abbreviation regression testing (compass
  // direction abbreviation, ordinal digits, and street type all in one name
  // at once). See tmap spec.md's Label creation section.
  '560 riverside dr, new york, ny': 'test-data/560-riverside-dr-new-york-ny.json',
  // Near-POIs (within 0.5mi of the matching anchor above -- joins the
  // current map as an additional POI). See test-data/README.md for exact
  // measured distances.
  '2323 fillmore st, san francisco, ca': 'test-data/2323-fillmore-st-san-francisco-ca.json',
  '2199 sacramento st, san francisco, ca': 'test-data/2199-sacramento-st-san-francisco-ca.json',
  '1600 hearst ave, berkeley, ca': 'test-data/1600-hearst-ave-berkeley-ca.json',
  '1400 hearst ave, berkeley, ca': 'test-data/1400-hearst-ave-berkeley-ca.json',
  '2100 university ave, berkeley, ca': 'test-data/2100-university-ave-berkeley-ca.json',
  '2224 shattuck ave, berkeley, ca': 'test-data/2224-shattuck-ave-berkeley-ca.json',
  // All three within 0.5mi of the 261 6th Ave anchor -- together they make
  // a real multi-POI map without needing a too-far case of their own.
  '592 carroll st, brooklyn, ny': 'test-data/592-carroll-st-brooklyn-ny.json',
  '26 garfield pl, brooklyn, ny': 'test-data/26-garfield-pl-brooklyn-ny.json',
  '851 president st, brooklyn, ny': 'test-data/851-president-st-brooklyn-ny.json',
  // Too-far POIs (beyond 0.5mi of the matching anchor above -- triggers the
  // "that's too far for one map" dialog; each also has full ways data, so
  // "Show new location" can promote it to a new anchor from cache too). All
  // four anchors above are >0.5mi from each other too, so any one also
  // works as a too-far POI relative to any of the others (Brooklyn is
  // obviously far from all three CA anchors).
  '2400 fillmore st, san francisco, ca': 'test-data/2400-fillmore-st-san-francisco-ca.json',
  '1801 california st, san francisco, ca': 'test-data/1801-california-st-san-francisco-ca.json',
  '1520 walnut st, berkeley, ca': 'test-data/1520-walnut-st-berkeley-ca.json'
};

// In-memory cache of already-fetched test-data files, so geocode() and
// fetchWays() (both of which consult the same cached dataset for a given
// search) don't each trigger their own fetch of the same JSON file.
const localTestDataCache = new Map();

// Returns { geocode, ways } for a cached query, or null if the cache is off
// or this query isn't one of the cached addresses (in which case callers
// fall back to the real network request, same as ever).
async function loadLocalTestData(query) {
  if (!USE_LOCAL_TEST_DATA_CACHE || !query) return null;
  const file = LOCAL_TEST_DATA_FILES[query.trim().toLowerCase()];
  if (!file) return null;
  if (localTestDataCache.has(file)) return localTestDataCache.get(file);
  const res = await fetch(file);
  if (!res.ok) throw new Error('local-test-data-missing: ' + file);
  const data = await res.json();
  localTestDataCache.set(file, data);
  return data;
}

// Settings-ready variables (see tmap spec.md § Settings) — not yet exposed in a UI,
// but kept as named constants rather than inlined so the Settings dialog has a real
// value to bind to later.
//
// Larger than the earlier 0.15mi test value now that Scale/Pan (Phase 1
// item 6) exist -- the original concern about a big fetch being too dense
// to read by touch was about cramming the whole fetch region into the
// display at once, which no longer happens now that only a scale-sized
// viewport window is ever shown. Not yet the spec's real [1 mile] default,
// though: empirically tested both directly against the public Overpass
// instance (isolated single requests, not rate-limit noise) -- 1 mile
// half-side reliably times out (504 after ~13s) for this dense test area,
// while 0.5 miles reliably succeeds (~3s, ~400KB). 0.5mi gets Scale changes
// visibly working up toward the 1000ft preset with some room to pan.
// Revisit once a non-public/self-hosted Overpass endpoint is used -- this
// constraint is about the fetch payload itself, independent of whatever
// processWays does (or doesn't) do with it afterward.
const POI_DISTANCE_THRESHOLD_MILES = 0.5;

// § Settings — the first of this block's settings to actually get a real
// UI (see the Settings dialog wiring further down): which braille code
// the message display sends to the physical Dot Pad in. 'computer8' is
// the existing 8-dot computer braille (NABCC); 'ueb1'/'ueb2' route
// through braille-ueb.js instead (see tmap spec.md § Braille translator).
// Defaults to Grade 2 (contracted) per spec. Only affects the message
// display -- street labels always render as 8-dot computer braille via
// NABCC regardless of this setting (see labelCharacterDots).
let brailleCodeSetting = 'ueb2';

// § Settings — Imperial ('imperial': in/ft/mi) or Metric ('metric': cm/m/km).
// Affects the Scale control's ladder/label (see SCALE_PRESETS_M,
// formatScaleLabel, viewportSizeFeet) and how distances from the anchor POI
// are reported (see formatDistance) -- panning and the "too far" new-POI
// prompt. Defaults to Imperial, matching every other distance/scale value
// in this file predating this setting.
let unitSystem = 'imperial';

// Matches DotSVG's 600x400 canvas (10:1 over the 60x40 dot grid) — see tmap spec.md
// § SVG Display Requirements (3x2 canvas ratio).
const SVG_WIDTH = 600;
const SVG_HEIGHT = 400;
const MILES_TO_METERS = 1609.344;
const CM_PER_INCH = 2.54;

// § Cursor and hit testing — the cursor/hit-testing grid is fixed at the
// Dot Pad's native 60x40 dot resolution (confirmed via the on-connect
// device-info diagnostic: numberCellColumns=30, numberCellRows=10) and is
// independent of whether a device is actually connected, per the Hardware
// requirement that the app works standalone.
const DOT_GRID_WIDTH = 60;
const DOT_GRID_HEIGHT = 40;
const SVG_UNITS_PER_DOT = SVG_WIDTH / DOT_GRID_WIDTH; // 10
const CURSOR_SVG_RADIUS = SVG_UNITS_PER_DOT * 1.5;

// § Braille labels — label zones are windows adjacent to the map viewbox,
// carved out of the fixed DOT_GRID_WIDTH/HEIGHT canvas rather than growing
// it (the physical Dot Pad grid never changes size). Left/right zones need
// 10 dot columns each (6 for 3 braille characters + 2 kerning + 2 padding);
// top/bottom need 5 dot rows each (3 for the braille dots + 2 padding).
const LABEL_ZONE_DOT_COLS = 10;
const LABEL_ZONE_DOT_ROWS = 5;
// § Scale behavior / § Settings — the 9 Traditional Scale presets ("1 in =
// Y ft"). DOT_PAD_DISPLAY_WIDTH_INCHES is the tactile display's measured
// width: 6 3/16 in (height is 4 1/8 in — exactly a 3:2 ratio, matching
// SVG_WIDTH:SVG_HEIGHT below, so height is still derived from width via
// that fixed ratio rather than tracked separately). Works out to ~9.7 dots
// per inch on both axes -- close enough to call it 10 DPI.
const SCALE_PRESETS_FT = [100, 200, 300, 400, 500, 1000, 1500, 2000, 5000];
// § Settings — the Metric counterpart of SCALE_PRESETS_FT ("1 cm = Y m"),
// chosen as the closest clean round-number ladder to each Imperial preset's
// *actual real-world footprint*, not to its raw ft number -- since the
// physical device is fixed in inches, "1 cm = Y m" and "1 in = X ft" only
// describe the same map footprint when Y = X * FEET_TO_METERS / CM_PER_INCH
// (which reduces to X * 0.12 exactly, since 0.3048 / 2.54 = 0.12). Each
// entry below is that exact conversion (100->12, 200->24, ... 5000->600)
// rounded to a nearby clean number (within ~5%, except the smallest preset
// at ~17%) -- see viewportSizeFeet, which is what actually applies
// whichever ladder is current, not just the label. Same length/index
// meaning as SCALE_PRESETS_FT so scaleIndex stays valid switching either
// direction; per an explicit user decision, the two ladders are
// independent round-number sets rather than exact conversions of each
// other, so the real-world map footprint does shift slightly (by whatever
// the rounding introduced) when Units is toggled.
const SCALE_PRESETS_M = [10, 25, 35, 50, 60, 120, 180, 250, 600];
const DEFAULT_SCALE_INDEX = 3; // 400 ft / 50 m
const DOT_PAD_DISPLAY_WIDTH_INCHES = 6 + 3 / 16;

// § Pan Behavior / § Settings — Pan Amount, in units of display width/
// height, shared by both horizontal and vertical pans (a single control,
// see settingsPanAmountSelect below -- an explicit user decision, not a
// pair of independent horizontal/vertical settings). Default 1/4.
let panAmountFraction = 0.25;

// § Settings — how long cursor-only mode stays on before automatically
// reverting to "Features restored" on its own, per the Cursor Solo Timeout
// setting: a number of seconds, or the string 'none' (no auto-revert --
// manual toggle only, today's original behavior). Declared here (not
// nearer cursorOnlyMode below) specifically so it's already initialized by
// the time loadPersistedSettings() runs at module load -- that call sits
// between here and cursorOnlyMode's declaration, and would otherwise throw
// a temporal-dead-zone ReferenceError reading this before its own
// initializer ran. See startCursorSoloTimer/clearCursorSoloTimer below.
let cursorSoloTimeoutSeconds = 2;

// § Auto Simplification — same early-declaration reasoning as
// cursorSoloTimeoutSeconds directly above: loadPersistedSettings() reads
// this at module load, before its original declaration site (near
// mapComplexityIndex) would have run, which throws the same
// temporal-dead-zone ReferenceError. A lasting preference (persisted, like
// Braille Translation/Units/Pan Amount/Cursor Solo Timeout), not per-map
// state -- unlike mapComplexityIndex itself, this is never reset on a new
// anchor. Checked (on) by default.
let autoSimplifyEnabled = true;
let cursorSoloTimeoutHandle = null;

// § Street importance tiers — every way gets tagged with a tier in
// processWays, purely as data for the Map Complexity filter (see
// MAP_COMPLEXITY_LEVELS/visibleWays). An unrecognized highway value (the
// Overpass query has no class filter, so lifecycle tags like construction/
// proposed can come through) falls to tier 7 rather than crashing.
const HIGHWAY_TIERS = {
  motorway: 1, trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  unclassified: 5, residential: 5, living_street: 5,
  service: 6,
  footway: 7, path: 7, cycleway: 7, pedestrian: 7, steps: 7
};
const MAX_TIER = 7;

// § Editing the Map — Map Complexity radio options, most to least detail.
// Each level is a maxTier cutoff (a way is visible only if its tier is <=
// maxTier) -- a strict nested ladder (highways ⊂ major ⊂ simplified ⊂ all),
// not independent per-tier toggles. Index in this array doubles as the
// 1-4 hotkey mapping (see the keydown handler) and the Edit Map dialog's
// radio button order.
const MAP_COMPLEXITY_LEVELS = [
  { label: 'All streets and pathways', maxTier: MAX_TIER },
  { label: 'Simplified neighborhoods', maxTier: 5 },
  { label: 'Major streets', maxTier: 4 },
  { label: 'Major highways', maxTier: 1 }
];

// A street "hits" the cursor when it passes within this many grid units of
// the cursor's center — an approximation of "intersects the cursor's edge"
// (tmap spec.md § Cursor and hit testing) sized to roughly match the small
// 4x4 cursor footprint. To be refined once this is visible on hardware.
const CURSOR_HIT_RADIUS = 2;

// § POIs — a POI marker's footprint, in grid dots (see createPoiMarkerSvg).
// Also used by Pan Behavior's clipping-avoidance nudge (see panMap) to
// know how close to a map/label-zone boundary is "too close."
const POI_MARKER_DOTS = 3;

const browserWarning = document.getElementById('browser-warning');
const devCacheBanner = document.getElementById('dev-cache-banner');
const devEmulatorBanner = document.getElementById('dev-emulator-banner');
const startInstructions = document.getElementById('start-instructions');
const btnNewMapStandalone = document.getElementById('btn-new-map-standalone');
const newMenuContainer = document.getElementById('new-menu-container');
const newMenuButton = document.getElementById('new-menu-button');
const newMenu = document.getElementById('new-menu');
const menuNewMap = document.getElementById('menu-new-map');
const menuNewPin = document.getElementById('menu-new-pin');
const newMapDialog = document.getElementById('new-map-dialog');
const newMapInstructions = document.getElementById('new-map-instructions');
const newMapForm = document.getElementById('new-map-form');
const newMapLocationInput = document.getElementById('new-map-location');
const btnNewMapCancel = document.getElementById('btn-new-map-cancel');
const anchorHeading = document.getElementById('anchor-heading');
const mapSvg = document.getElementById('map');
const messageDisplay = document.getElementById('message-display');
// role="alert"/aria-live are set here in JS rather than baked into
// index.html's static markup -- a role="alert" live region present in the
// raw page markup gets announced by some screen readers (confirmed on
// NVDA) as a bare, contentless "alert" purely because the region exists
// at page load, before setMessage() ever writes real text into it. Adding
// the attributes after the initial parse avoids that phantom announcement
// entirely; every real setMessage() call still gets announced normally.
messageDisplay.setAttribute('role', 'alert');
messageDisplay.setAttribute('aria-live', 'assertive');
const btnConnect = document.getElementById('btn-connect');
const mainMenuButton = document.getElementById('main-menu-button');
const mainMenu = document.getElementById('main-menu');
const scaleSelect = document.getElementById('scale-select');
const labelCheckboxes = {
  top: document.getElementById('label-top'),
  bottom: document.getElementById('label-bottom'),
  left: document.getElementById('label-left'),
  right: document.getElementById('label-right')
};
const poiListSelect = document.getElementById('poi-list');
const btnGotoPin = document.getElementById('btn-goto-pin');
const poiTooFarDialog = document.getElementById('poi-too-far-dialog');
const poiTooFarMessage = document.getElementById('poi-too-far-message');
const btnPoiShowAnyway = document.getElementById('btn-poi-show-anyway');
const btnPoiCancel = document.getElementById('btn-poi-cancel');
const didYouMeanDialog = document.getElementById('did-you-mean-dialog');
const didYouMeanList = document.getElementById('did-you-mean-list');
const btnDidYouMeanCancel = document.getElementById('btn-did-you-mean-cancel');
const customPoiDialog = document.getElementById('custom-poi-dialog');
const customPoiStatus = document.getElementById('custom-poi-status');
const customPoiForm = document.getElementById('custom-poi-form');
const customPoiNameInput = document.getElementById('custom-poi-name');
const btnCustomPoiSearch = document.getElementById('btn-custom-poi-search');
const btnCustomPoiCancel = document.getElementById('btn-custom-poi-cancel');
const editPinDialog = document.getElementById('edit-pin-dialog');
const editPinInstructions = document.getElementById('edit-pin-instructions');
const editPinForm = document.getElementById('edit-pin-form');
const editPinNameInput = document.getElementById('edit-pin-name');
const btnEditPinCancel = document.getElementById('btn-edit-pin-cancel');
const btnEditPinDelete = document.getElementById('btn-edit-pin-delete');
const btnEditMap = document.getElementById('menu-customize-map');
const editMapDialog = document.getElementById('edit-map-dialog');
const editMapPoisList = document.getElementById('edit-map-pois-list');
const editMapVisibleStreetsList = document.getElementById('edit-map-visible-streets-list');
const editMapHiddenFeaturesList = document.getElementById('edit-map-hidden-features-list');
const editMapComplexityList = document.getElementById('edit-map-complexity-list');
const btnEditMapClose = document.getElementById('btn-edit-map-close');
const btnMyArchives = document.getElementById('menu-my-archives');
const myArchivesDialog = document.getElementById('my-archives-dialog');
const btnMyArchivesDone = document.getElementById('btn-my-archives-done');
const recentMapsBody = document.getElementById('recent-maps-body');
const btnClearHistory = document.getElementById('btn-clear-history');
const savedMapsBody = document.getElementById('saved-maps-body');
const savedMapsSortDate = document.getElementById('saved-maps-sort-date');
const savedMapsSortName = document.getElementById('saved-maps-sort-name');
const btnSaveCurrentMap = document.getElementById('btn-save-current-map');
const rowActionsMenu = document.getElementById('row-actions-menu');
const rowActionsEdit = document.getElementById('row-actions-edit');
const rowActionsDelete = document.getElementById('row-actions-delete');
const saveMapDialog = document.getElementById('save-map-dialog');
const saveMapForm = document.getElementById('save-map-form');
const saveMapNameInput = document.getElementById('save-map-name');
const saveMapNotesInput = document.getElementById('save-map-notes');
const btnSaveMapCancel = document.getElementById('btn-save-map-cancel');
const deleteSavedMapDialog = document.getElementById('delete-saved-map-dialog');
const deleteSavedMapMessage = document.getElementById('delete-saved-map-message');
const btnDeleteSavedMapYes = document.getElementById('btn-delete-saved-map-yes');
const btnDeleteSavedMapCancel = document.getElementById('btn-delete-saved-map-cancel');
const btnDownloadSvg = document.getElementById('menu-download-svg');
const btnFileIssue = document.getElementById('btn-file-issue');
const btnSettings = document.getElementById('menu-display-preferences');
const btnLogin = document.getElementById('menu-login');
const btnLogout = document.getElementById('menu-logout');
const btnDisconnect = document.getElementById('menu-disconnect');
const settingsDialog = document.getElementById('settings-dialog');
const settingsBrailleCodeSelect = document.getElementById('settings-braille-code');
const settingsUnitsSelect = document.getElementById('settings-units');
const settingsPanAmountSelect = document.getElementById('settings-pan-amount');
const settingsCursorSoloTimeoutSelect = document.getElementById('settings-cursor-solo-timeout');
const settingsAutoSimplifyCheckbox = document.getElementById('settings-auto-simplify');
const btnSettingsDone = document.getElementById('btn-settings-done');
const btnHelp = document.getElementById('menu-help');
const btnHelpFooter = document.getElementById('btn-help-footer');
const helpDialog = document.getElementById('help-dialog');
const helpContent = document.getElementById('help-content');
const btnHelpClose = document.getElementById('btn-help-close');
const btnReleaseNotes = document.getElementById('menu-release-notes');
const releaseNotesDialog = document.getElementById('release-notes-dialog');
const releaseNotesContent = document.getElementById('release-notes-content');
const btnReleaseNotesClose = document.getElementById('btn-release-notes-close');
const streetListDialog = document.getElementById('street-list-dialog');
const streetListContent = document.getElementById('street-list-content');
const btnStreetListClose = document.getElementById('btn-street-list-close');

let hasAnchor = false;

// § Additional POIs — locations beyond the anchor, each with a triangle
// marker and an entry in the POI list box. Cleared whenever a new anchor
// is created (a discarded map takes its POIs with it).
let additionalPois = []; // { name, lat, lon }

// Holds the pending too-far location while the confirmation dialog is open,
// so "Show new location" knows what to do (see promptTooFarPoi).
let pendingFarPoi = null;

// § Screen Layout — Dot Pad connection state. Connect Dot Pad (main screen)
// and Disconnect Dot Pad (bottom of the Main Menu) are never both present
// at once (see setConnectedState/setDisconnectedState).
const sdk = new DotPadSDK();
const scanner = new DotPadScanner();
let currentDevice = null;

// Last-rendered map data, kept so a device that connects after a map is already
// showing can be synced immediately (see setConnectedState).
let lastBbox = null;
// lastRawWays is exactly what Overpass returned; lastWays is
// processWays(lastRawWays) -- currently just tags each way with its tier
// (manual-declutter experiment, see git tag `pre-manual-declutter` on main
// for the dedup/collapse stages that used to also run here), but kept as a
// separate step/variable in case more gets added back later.
let lastRawWays = [];
let lastWays = [];
let lastAnchorLat = null;
let lastAnchorLon = null;
let lastAnchorName = null;

// § My Archives — the raw search text that produced the current anchor.
// Never part of the real Overpass query (see fetchWays) -- stored only so
// the local Overpass/Nominatim test-data cache still matches when a
// developer tests loading a Recent/Saved map locally.
let lastSearchQuery = null;

// § Scale behavior / § Pan Behavior — the viewport is the sub-window of the
// fetched data (lastBbox) actually shown at the current scale. Center starts
// at the anchor POI on each new search; scaleIndex indexes SCALE_PRESETS_FT.
let viewportCenterLat = null;
let viewportCenterLon = null;
let scaleIndex = DEFAULT_SCALE_INDEX;

// § Braille labels / § Settings — shared toggle state for the 4 label
// zones, driven equally by the dialog checkboxes and the i/j/k/l hotkeys
// (see spec § Command / hotkey mapping). [none checked] is the default.
let labelZones = { top: false, bottom: false, left: false, right: false };

// § Settings — Settings persistence across sessions, local-only via
// localStorage, independent of sign-in (see tmap spec.md § Settings /
// Accounts and Data). Covers exactly the five settings that already
// survive a new anchor search unchanged (brailleCodeSetting, unitSystem,
// panAmountFraction, labelZones, cursorSoloTimeoutSeconds,
// autoSimplifyEnabled) -- deliberately NOT scaleIndex or mapComplexityIndex
// itself, since
// showAnchor already resets that to DEFAULT_SCALE_INDEX on every new
// search regardless of any prior value, so persisting it would silently
// do nothing (it'd load correctly, then get overwritten the instant a
// search happens) and risk looking like a broken feature rather than no
// feature at all.
// -dev suffix on tmapdev (see IS_DEV_BUILD) so this never collides with
// production's own settings on the shared touchout.org origin.
const SETTINGS_STORAGE_KEY = 'dottmap-settings' + (IS_DEV_BUILD ? '-dev' : '');

// Reads and validates persisted settings, applying only fields that pass
// a sanity check against the actual set of valid values -- localStorage
// content can't be trusted blindly (a future app version could narrow the
// valid set, or the value could be corrupted/hand-edited), so an invalid
// field is just left at its normal built-in default rather than applied
// as-is or treated as a fatal error.
function loadPersistedSettings() {
  let stored;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    stored = JSON.parse(raw);
  } catch (err) {
    return;
  }
  if (!stored || typeof stored !== 'object') return;

  if (stored.brailleCodeSetting === 'computer8' || stored.brailleCodeSetting === 'ueb1' || stored.brailleCodeSetting === 'ueb2') {
    brailleCodeSetting = stored.brailleCodeSetting;
  }
  if (stored.unitSystem === 'imperial' || stored.unitSystem === 'metric') {
    unitSystem = stored.unitSystem;
  }
  if (typeof stored.panAmountFraction === 'number' && [0.25, 0.5, 0.75, 1].includes(stored.panAmountFraction)) {
    panAmountFraction = stored.panAmountFraction;
  }
  if (stored.labelZones && typeof stored.labelZones === 'object') {
    for (const zone of ['top', 'bottom', 'left', 'right']) {
      if (typeof stored.labelZones[zone] === 'boolean') labelZones[zone] = stored.labelZones[zone];
    }
  }
  if (stored.cursorSoloTimeoutSeconds === 'none' || [1, 2, 3, 5].includes(stored.cursorSoloTimeoutSeconds)) {
    cursorSoloTimeoutSeconds = stored.cursorSoloTimeoutSeconds;
  }
  if (typeof stored.autoSimplifyEnabled === 'boolean') {
    autoSimplifyEnabled = stored.autoSimplifyEnabled;
  }
}

// Called after every change to one of the five persisted settings (see
// each control's own change listener, and setLabelZone). Failure (e.g.
// storage disabled/full in this browser) is silently ignored -- this is a
// convenience feature, not a P0 requirement to surface errors for like
// Nominatim/Overpass failures are.
function savePersistedSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      brailleCodeSetting,
      unitSystem,
      panAmountFraction,
      labelZones,
      cursorSoloTimeoutSeconds,
      autoSimplifyEnabled
    }));
  } catch (err) {
    // Ignored -- see comment above.
  }
}

loadPersistedSettings();

// § Editing the Map — names of POIs/streets the user has unchecked in the
// Edit Map dialog (Streets and Pedestrian Pathways are merged into one
// name-keyed set now that the dialog no longer classifies by way class).
// Hidden features stay in additionalPois/lastWays (and in the dialog's own
// Hidden Streets/POIs list, so they can be turned back on) but are skipped
// by rendering, hit-testing, and the tactile raster -- see visiblePois() /
// visibleWays(). Reset whenever a brand-new anchor discards the old map
// (see showAnchor); untouched by pan/scale/complexity changes, which reuse
// the same fetched data. Every change here takes effect immediately (the
// Edit Map dialog has no Save/Cancel staging step) and refreshes the map.
let hiddenPoiNames = new Set();
let hiddenStreetNames = new Set();

// § Editing the Map — index into MAP_COMPLEXITY_LEVELS for the Map
// Complexity radio group's current selection. Independent of
// hiddenStreetNames -- a manually-hidden street stays hidden regardless of
// complexity level, and changing complexity never touches hiddenStreetNames
// (see visibleWays(), which ANDs both filters). Reset to 0 ("All streets
// and pathways") on a brand-new anchor.
let mapComplexityIndex = 0;

// § Command / hotkey mapping — the 0 hotkey's "show only the cursor" mode.
// A display-only override, not a real edit: when true, visibleWays()/
// visiblePois() both short-circuit to empty, so rendering, the tactile
// raster, and cursor hit-testing all show nothing but the cursor -- but
// hiddenStreetNames/hiddenPoiNames/mapComplexityIndex are never touched,
// so toggling this back off restores exactly whatever was showing before.
// The on-screen POI dropdown is unaffected either way (it's a navigation
// aid keyed off hiddenPoiNames directly, not visiblePois()). Reset to
// false on a brand-new anchor, same as the other Edit Map state.
let cursorOnlyMode = false;

// The map's effective drawable region within the fixed DOT_GRID_WIDTH x
// DOT_GRID_HEIGHT canvas, after carving out whichever label zones are
// active. All grid/SVG/device projections for streets, cursor, and hit
// testing operate within this sub-region rather than the full canvas.
function mapGridBounds() {
  const offsetX = labelZones.left ? LABEL_ZONE_DOT_COLS : 0;
  const offsetY = labelZones.top ? LABEL_ZONE_DOT_ROWS : 0;
  const width = DOT_GRID_WIDTH - offsetX - (labelZones.right ? LABEL_ZONE_DOT_COLS : 0);
  const height = DOT_GRID_HEIGHT - offsetY - (labelZones.bottom ? LABEL_ZONE_DOT_ROWS : 0);
  return { offsetX, offsetY, width, height };
}

// Same region, in on-screen SVG units (see SVG_UNITS_PER_DOT).
function svgMapRect() {
  const b = mapGridBounds();
  return {
    x: b.offsetX * SVG_UNITS_PER_DOT,
    y: b.offsetY * SVG_UNITS_PER_DOT,
    width: b.width * SVG_UNITS_PER_DOT,
    height: b.height * SVG_UNITS_PER_DOT
  };
}

// Cursor position, stored as a real-world lat/lon (not grid units) so it
// stays fixed relative to the map through pan and scale changes rather than
// jumping around when the viewport underneath it moves. null until a map
// has been loaded. Grid/display position is derived fresh from this each
// render (see cursorGridPosition/updateCursorVisual), and clamped to the
// current viewport's bounds -- if the cursor's real position is temporarily
// outside the visible area, it displays pinned to the nearest edge without
// forgetting where it actually is, so panning back brings it into view
// again at the same real-world spot.
let cursorLat = null;
let cursorLon = null;
const cursorSvg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
cursorSvg.setAttribute('class', 'cursor');
cursorSvg.setAttribute('r', CURSOR_SVG_RADIUS);
cursorSvg.hidden = true;

// § Pan Behavior — mouse-only visual affordance replacing the old on-screen
// Move Map buttons: a subtle bar along the middle of each edge of the map,
// brightening on hover, that pans the same single step a click on the old
// buttons did. Deliberately invisible to assistive tech -- Ctrl+Arrow (see
// the keydown handler below) is the keyboard/screen-reader path for panning
// and is unaffected by any of this; #map's own role="img" already collapses
// its children out of the accessibility tree, and aria-hidden here is just
// explicit belt-and-suspenders documentation of that intent, not content
// being hidden that AT users would otherwise need. Plain <rect>s with no
// tabindex/role, so they're not independently focusable either. Persistent
// elements re-appended each render (see positionPanEdgeBars/renderScene),
// same pattern as cursorSvg above -- renderScene wipes and rebuilds #map's
// entire content on every refresh, so anything meant to survive a render
// has to be created once and re-attached, not left inline in markup.
function createPanEdgeBar(direction) {
  const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bar.setAttribute('class', 'pan-edge-bar');
  bar.setAttribute('aria-hidden', 'true');
  bar.setAttribute('rx', 4);
  bar.addEventListener('click', () => panMap(direction));
  return bar;
}
const panEdgeBarNorth = createPanEdgeBar('north');
const panEdgeBarSouth = createPanEdgeBar('south');
const panEdgeBarEast = createPanEdgeBar('east');
const panEdgeBarWest = createPanEdgeBar('west');
const panEdgeBars = [panEdgeBarNorth, panEdgeBarSouth, panEdgeBarEast, panEdgeBarWest];

// Sizes/positions the four bars against the map's *current* drawable
// sub-rectangle (see svgMapRect) -- not the fixed 600x400 canvas -- so they
// track label zones shrinking/offsetting the map the same way streets and
// the cursor already do. Each bar spans PAN_EDGE_BAR_LENGTH_FRACTION of its
// edge's length, centered, at PAN_EDGE_BAR_THICKNESS thick.
const PAN_EDGE_BAR_THICKNESS = 20; // 2 dots, see SVG_UNITS_PER_DOT
const PAN_EDGE_BAR_LENGTH_FRACTION = 0.4;

function positionPanEdgeBars() {
  const rect = svgMapRect();

  const hBarWidth = rect.width * PAN_EDGE_BAR_LENGTH_FRACTION;
  const hBarX = rect.x + (rect.width - hBarWidth) / 2;
  panEdgeBarNorth.setAttribute('x', hBarX);
  panEdgeBarNorth.setAttribute('y', rect.y);
  panEdgeBarNorth.setAttribute('width', hBarWidth);
  panEdgeBarNorth.setAttribute('height', PAN_EDGE_BAR_THICKNESS);

  panEdgeBarSouth.setAttribute('x', hBarX);
  panEdgeBarSouth.setAttribute('y', rect.y + rect.height - PAN_EDGE_BAR_THICKNESS);
  panEdgeBarSouth.setAttribute('width', hBarWidth);
  panEdgeBarSouth.setAttribute('height', PAN_EDGE_BAR_THICKNESS);

  const vBarHeight = rect.height * PAN_EDGE_BAR_LENGTH_FRACTION;
  const vBarY = rect.y + (rect.height - vBarHeight) / 2;
  panEdgeBarWest.setAttribute('x', rect.x);
  panEdgeBarWest.setAttribute('y', vBarY);
  panEdgeBarWest.setAttribute('width', PAN_EDGE_BAR_THICKNESS);
  panEdgeBarWest.setAttribute('height', vBarHeight);

  panEdgeBarEast.setAttribute('x', rect.x + rect.width - PAN_EDGE_BAR_THICKNESS);
  panEdgeBarEast.setAttribute('y', vBarY);
  panEdgeBarEast.setAttribute('width', PAN_EDGE_BAR_THICKNESS);
  panEdgeBarEast.setAttribute('height', vBarHeight);
}

// § My Archives — captures everything needed to push the current map into
// Map History or Saved Maps. Deliberately excludes display preferences
// (braille translation, label zones, scale, map complexity, cursor-only
// mode) -- those aren't map data. Street/way geometry is excluded too;
// only which streets are hidden is kept, since geometry is always
// re-fetched live from Overpass on load (see loadMapRecord), matching
// this app's live-data approach elsewhere.
function captureCurrentMap() {
  return {
    anchorName: lastAnchorName,
    anchorLat: lastAnchorLat,
    anchorLon: lastAnchorLon,
    searchQuery: lastSearchQuery,
    additionalPois: additionalPois.map((poi) => ({ ...poi })),
    hiddenPoiNames: [...hiddenPoiNames],
    hiddenStreetNames: [...hiddenStreetNames],
    viewportCenterLat,
    viewportCenterLon
  };
}

// § My Archives — the current map lives locally (independent of sign-in)
// until it's replaced by a new one (see archiveOutgoingMapIfNeeded) or
// explicitly saved (see saveCurrentMapAs). Persisted so a page reload
// doesn't lose an in-progress map. Follows the same try/catch-swallowed,
// field-validated convention as loadPersistedSettings/savePersistedSettings
// above.
// -dev suffix on tmapdev (see IS_DEV_BUILD), same reasoning as
// SETTINGS_STORAGE_KEY above.
const CURRENT_MAP_STORAGE_KEY = 'dottmap-current-map' + (IS_DEV_BUILD ? '-dev' : '');

function saveCurrentMapLocally() {
  if (!hasAnchor) return;
  try {
    localStorage.setItem(CURRENT_MAP_STORAGE_KEY, JSON.stringify({
      ...captureCurrentMap(),
      updatedAt: new Date().toISOString()
    }));
  } catch (err) {
    // Ignored -- see savePersistedSettings above.
  }
}

function loadPersistedCurrentMap() {
  try {
    const raw = localStorage.getItem(CURRENT_MAP_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== 'object') return null;
    if (typeof stored.anchorName !== 'string' || typeof stored.anchorLat !== 'number' || typeof stored.anchorLon !== 'number') return null;
    return stored;
  } catch (err) {
    return null;
  }
}

// § My Archives — the current map's raw Overpass ways, cached locally via
// IndexedDB (too large and too slow to JSON.stringify/parse on every
// change for localStorage, unlike the small metadata record above) so a
// page reload can restore the current map without re-fetching from
// Overpass. A single slot, not a general cache: written every time the
// current map's ways change (see showAnchor) and read once at startup.
// Deliberately no staleness check -- a hit is used regardless of age (the
// user can always search again to force a live refresh). Map History and
// Saved Maps entries never read this -- see loadMapRecord's cachedWays
// parameter -- so this can never show stale data anywhere except the
// exact map already on screen when the page reloads.
// -dev suffix on tmapdev (see IS_DEV_BUILD), same reasoning as
// SETTINGS_STORAGE_KEY/CURRENT_MAP_STORAGE_KEY above -- a distinct
// IndexedDB database, not just a distinct object store, so the two
// sites' cached ways can never cross-contaminate.
const WAYS_CACHE_DB_NAME = 'dottmap-ways-cache' + (IS_DEV_BUILD ? '-dev' : '');
const WAYS_CACHE_STORE = 'currentMapWays';
const WAYS_CACHE_KEY = 'current';

function openWaysCacheDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WAYS_CACHE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(WAYS_CACHE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Failure (storage disabled/unavailable, quota exceeded, etc.) is silently
// swallowed -- same convention as savePersistedSettings/saveCurrentMapLocally
// above: this is a convenience cache, not something to surface an error for.
async function saveCurrentMapWaysLocally(ways) {
  try {
    const db = await openWaysCacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(WAYS_CACHE_STORE, 'readwrite');
      tx.objectStore(WAYS_CACHE_STORE).put(ways, WAYS_CACHE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    // Ignored -- see comment above.
  }
}

// Returns null on any miss or failure (no cached entry, corrupted DB,
// storage unavailable) -- the caller's job is just to fall back to a live
// Overpass fetch, exactly like before this cache existed.
async function loadCurrentMapWaysLocally() {
  try {
    const db = await openWaysCacheDb();
    const ways = await new Promise((resolve, reject) => {
      const tx = db.transaction(WAYS_CACHE_STORE, 'readonly');
      const req = tx.objectStore(WAYS_CACHE_STORE).get(WAYS_CACHE_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return Array.isArray(ways) ? ways : null;
  } catch (err) {
    return null;
  }
}

// § Browser check
function isChrome() {
  const ua = navigator.userAgent;
  return /Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua);
}
if (!isChrome()) {
  browserWarning.hidden = false;
}

// § Screen Layout — Connect Dot Pad receives focus on page load (explicit
// requirement). The HTML autofocus attribute alone proved unreliable on
// the real deployed site (element confirmed present and genuinely
// focusable, but focus didn't actually land there on a real page load) --
// calling focus() explicitly is the standard, more robust fix for exactly
// this kind of autofocus flakiness across browsers/tab states.
btnConnect.focus();

// § Local test data cache — unmissable visual flag (not just a code
// comment) that this build is serving cached data instead of hitting the
// real Nominatim/Overpass endpoints, so it can't accidentally slip into a
// deploy/push unnoticed.
if (USE_LOCAL_TEST_DATA_CACHE) {
  devCacheBanner.hidden = false;
}

// § Firebase local emulator — same unmissable-banner treatment as the OSM
// test-data cache above, for the same reason.
if (USE_FIREBASE_EMULATORS) {
  devEmulatorBanner.hidden = false;
}

// § Message display architecture — the physical message display's fixed
// size (confirmed via on-screen device-info diagnostic: this hardware
// reports numberBrailleCellColumns=20, matching the spec). Deliberately
// a constant here, not read from currentDevice.numberBrailleCellColumns
// (which sendCurrentMessageChunkToDevice below still does for the
// actual send): the virtual message window must exist and have a real
// first chunk ready even before a device is connected, when there's no
// device to query.
const MESSAGE_WINDOW_SIZE = 20;

// § Settings — the full (untranslated) text setMessage last sent, so the
// Settings dialog can rebuild the virtual message window under a newly
// selected braille code (see settingsBrailleCodeSelect's change listener
// below) without needing a fresh setMessage call -- the on-screen
// text/meaning haven't changed, only how the device copy gets encoded
// and re-paginated.
let lastMessageText = '';

// § Message display architecture — the virtual message window the 456/123
// chords page through (see tmap spec.md). messageWindowCells is the full
// translated cell sequence for lastMessageText under the current
// brailleCodeSetting; messageWindowChunkStarts is every valid chunk
// boundary within it (precomputed, not derived reactively per key press
// -- see computeChunkStarts); messageWindowChunkIndex is which of those
// chunks is currently shown on the device.
let messageWindowCells = [];
let messageWindowChunkStarts = [0];
let messageWindowChunkIndex = 0;

// § Message display architecture — translates text into cell bitmasks
// under the current brailleCodeSetting, and separately records every
// cell-index where a new word begins (i.e. right after a space), which
// is where a chunk boundary is allowed to fall. Splitting the source
// text at each space and translating the pieces individually rather
// than translating the whole string at once gives an identical cell
// sequence -- none of the three codes' translation logic depends on
// what's on the other side of a space -- while exposing exactly the
// boundary information chunking needs.
function translateCurrentCodeWithBreaks(text) {
  const segments = text.split(/( )/);
  const cells = [];
  const wordBreaks = [0];
  for (const seg of segments) {
    if (seg === '') continue;
    const segCells = brailleCodeSetting === 'ueb1' ? translateGrade1(seg)
      : brailleCodeSetting === 'ueb2' ? translateGrade2(seg)
      : textToNabccCells(seg);
    cells.push(...segCells);
    if (seg === ' ') wordBreaks.push(cells.length);
  }
  return { cells, wordBreaks };
}

// § Message display architecture — the end position of the chunk that
// starts at `start`, backing off to the nearest earlier word boundary
// so a chunk never splits a word, mirroring the old truncateMessage's
// space-backoff logic but generalized to any chunk in the sequence, not
// just the first one. Falls back to a hard cut at exactly
// MESSAGE_WINDOW_SIZE if no word boundary exists in the window (a
// single word/token longer than the whole display).
function chunkEndPosition(cellsLength, start, wordBreaks, width = MESSAGE_WINDOW_SIZE) {
  const idealEnd = Math.min(start + width, cellsLength);
  if (idealEnd >= cellsLength) return idealEnd;
  let best = idealEnd;
  let foundBreak = false;
  for (const b of wordBreaks) {
    if (b > start && b <= idealEnd) { best = b; foundBreak = true; }
  }
  return foundBreak ? best : idealEnd;
}

// § Message display architecture — every chunk's start position, in
// order, computed once per rebuild rather than reactively per key press
// -- so paging forward/back is just moving an index into this array
// (see the 456/123 chord handlers), not reconstructing where a previous
// chunk would have started.
function computeChunkStarts(cells, wordBreaks) {
  const starts = [0];
  let pos = 0;
  while (pos < cells.length) {
    pos = chunkEndPosition(cells.length, pos, wordBreaks);
    if (pos < cells.length) starts.push(pos);
  }
  return starts;
}

// § Message display architecture — re-translates lastMessageText (or a
// freshly-set message) into the virtual window, resetting to the first
// chunk. Called on every new message and whenever brailleCodeSetting
// changes (see settingsBrailleCodeSelect's change listener) -- chunk
// boundaries don't line up between codes anyway (contractions and
// capital/number signs change cell counts differently), so there's no
// sensible "same position" to preserve across a code change; starting
// over at chunk 0 is simplest and most predictable.
function rebuildMessageWindow(text) {
  const { cells, wordBreaks } = translateCurrentCodeWithBreaks(text);
  messageWindowCells = cells;
  messageWindowChunkStarts = computeChunkStarts(cells, wordBreaks);
  messageWindowChunkIndex = 0;
}

// § Message display architecture — sends whichever chunk
// messageWindowChunkIndex currently points at. No-op if no device is
// connected (mirrors setMessage's own existing guard).
function sendCurrentMessageChunkToDevice() {
  if (!currentDevice) return;
  const start = messageWindowChunkStarts[messageWindowChunkIndex];
  const end = messageWindowChunkIndex + 1 < messageWindowChunkStarts.length
    ? messageWindowChunkStarts[messageWindowChunkIndex + 1]
    : messageWindowCells.length;
  const numCells = currentDevice.numberBrailleCellColumns;
  const zeros = '00'.repeat(numCells);
  const hex = cellsToMessageHex(messageWindowCells.slice(start, end), numCells);
  sdk.displayTextData(zeros, currentDevice, DisplayMode.TextMode);
  sdk.displayTextData(hex, currentDevice, DisplayMode.TextMode);
}

// § Command / hotkey mapping — dots 4+5+6 together show the next chunk
// of the current message; dots 1+2+3 together show the previous one. If
// there's no next/previous chunk, the edge tone plays but the display
// keeps showing whatever's already there -- no message-field change, no
// device write, per tmap spec.md § Message display architecture.
function showNextMessageChunk() {
  if (messageWindowChunkIndex + 1 < messageWindowChunkStarts.length) {
    messageWindowChunkIndex++;
    sendCurrentMessageChunkToDevice();
  } else {
    playEdgeTone();
  }
}
function showPreviousMessageChunk() {
  if (messageWindowChunkIndex > 0) {
    messageWindowChunkIndex--;
    sendCurrentMessageChunkToDevice();
  } else {
    playEdgeTone();
  }
}

// § Message display architecture — the on-screen field is the single source of
// truth; it updates first, then pushes to the Dot Pad's 20-cell message display.
// The device copy is paginated into MESSAGE_WINDOW_SIZE-cell chunks (see the
// virtual message window above) rather than truncated -- the on-screen/ARIA
// side is never limited, only the physical device's own fixed-size display.
function setMessage(text, deviceDelayMs = 0) {
  lastMessageText = text;
  // § Message display architecture — the live region is cleared and forced
  // to reflow before being repopulated. Screen readers (confirmed on NVDA)
  // don't reliably treat a same-element textContent change as a fresh
  // assertive announcement that interrupts whatever's still being spoken;
  // clear-then-reflow-then-set is the standard technique for forcing that,
  // rather than letting rapid successive messages queue up and play in
  // full one after another.
  messageDisplay.textContent = '';
  void messageDisplay.offsetHeight;
  messageDisplay.textContent = text;
  rebuildMessageWindow(text);
  if (currentDevice) {
    if (deviceDelayMs > 0) {
      setTimeout(sendCurrentMessageChunkToDevice, deviceDelayMs);
    } else {
      sendCurrentMessageChunkToDevice();
    }
  }
}

// § Sound cues — secondary, non-verbal feedback alongside the message
// field. There's no standard way for a web page to trigger the OS/console
// bell, so cues are short tones synthesized with the Web Audio API --
// no external library or audio file needed. AudioContext is created lazily
// on first use, since browsers require it to happen inside a user-gesture
// event handler (a keypress or click, which every caller here already is).
let audioContext = null;
function playTone(frequency, durationMs) {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = new AudioContextClass();
  }
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.value = 0.2;
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + durationMs / 1000);
}

// Low, short "bump" tone for a boundary condition -- see tmap spec.md §
// Sound cues. Shared by Edge of Map (panning past the fetched data) and
// the message display window (paging past the first/last chunk).
function playEdgeTone() {
  playTone(220, 150);
}

// § Scale behavior — populate the combo box once from SCALE_PRESETS_FT.
SCALE_PRESETS_FT.forEach((_, index) => {
  const option = document.createElement('option');
  option.value = String(index);
  option.textContent = formatScaleLabel(index);
  scaleSelect.appendChild(option);
});
scaleSelect.value = String(DEFAULT_SCALE_INDEX);

// § Scale behavior — shared by the on-screen combo box and the changeScale
// hotkey helper below, so a mouse-driven scale change goes through the exact
// same update (message + refresh) as a keyboard/Dot Pad one, not a separate
// copy of the same logic.
function setScaleIndex(newIndex) {
  if (!lastBbox) return;
  newIndex = clamp(newIndex, 0, SCALE_PRESETS_FT.length - 1);
  if (newIndex === scaleIndex) return;
  scaleIndex = newIndex;
  scaleSelect.value = String(scaleIndex);
  // § Auto Simplification — resolved against the new scale (getViewportBbox
  // already reflects scaleIndex's new value at this point) before the one
  // refreshMap() call below, so the map never flashes an intermediate
  // complexity level.
  const simplifyLabel = maybeAutoAdjustComplexity();
  refreshMap();
  setMessage(simplifyLabel ? `${formatScaleLabel(scaleIndex)} ${simplifyLabel} visible.` : formatScaleLabel(scaleIndex));
}

scaleSelect.addEventListener('change', () => {
  setScaleIndex(Number(scaleSelect.value));
});

// § Braille labels — the checkboxes (living in the Settings dialog, under
// its own "Braille Options" heading) are a live view of the shared
// labelZones state (see setLabelZone), not a separately-synced copy: they
// apply immediately on change, matching the i/j/k/l hotkeys' effect too.
for (const zone in labelCheckboxes) {
  labelCheckboxes[zone].addEventListener('change', () => setLabelZone(zone, labelCheckboxes[zone].checked));
}

// § Screen Layout — Main Menu, a WAI-ARIA "Actions Menu Button" (prototyped
// on the OSM Data Mine experiment site before being brought in here):
// Customize Map, Download SVG, and Display Preferences (formerly three
// separate always-visible buttons) plus, only while a Dot Pad is connected,
// Disconnect Dot Pad at the bottom. Selecting an item takes effect
// immediately and closes the menu -- there's no persistent "current
// selection" state to indicate, since every item is an action, not an
// option. mainMenuItems() re-reads the DOM each time rather than caching a
// list, since which items are hidden (Disconnect Dot Pad) changes at
// runtime.
function mainMenuItems() {
  return Array.from(mainMenu.querySelectorAll('[role="menuitem"]')).filter((item) => !item.hidden);
}

function openMainMenu(focusIndex) {
  mainMenu.hidden = false;
  mainMenuButton.setAttribute('aria-expanded', 'true');
  focusMainMenuItem(focusIndex);
}

function closeMainMenu({ focusButton = false } = {}) {
  if (mainMenu.hidden) return;
  mainMenu.hidden = true;
  mainMenuButton.setAttribute('aria-expanded', 'false');
  if (focusButton) mainMenuButton.focus();
}

// Roving tabindex: only the item DOM focus currently sits on is reachable
// via Tab; arrow keys move both the tabindex and actual focus together.
function focusMainMenuItem(index) {
  const items = mainMenuItems();
  items.forEach((item, i) => item.setAttribute('tabindex', i === index ? '0' : '-1'));
  items[index].focus();
}

mainMenuButton.addEventListener('click', () => {
  if (mainMenu.hidden) {
    openMainMenu(0);
  } else {
    closeMainMenu();
  }
});

mainMenuButton.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openMainMenu(0);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    openMainMenu(mainMenuItems().length - 1);
  }
});

// Arrow/Home/End/Escape/Tab navigation is identical for every item
// regardless of which action it performs, so it's wired once here for all
// of them (including Disconnect Dot Pad while hidden -- harmless, since
// mainMenuItems() only ever computes indices among currently-visible items).
Array.from(mainMenu.querySelectorAll('[role="menuitem"]')).forEach((item) => {
  item.addEventListener('keydown', (event) => {
    const items = mainMenuItems();
    const index = items.indexOf(item);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusMainMenuItem((index + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusMainMenuItem((index - 1 + items.length) % items.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusMainMenuItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusMainMenuItem(items.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMainMenu({ focusButton: true });
    } else if (event.key === 'Tab') {
      closeMainMenu();
    }
  });
});

document.addEventListener('click', (event) => {
  if (!mainMenu.hidden && !event.target.closest('#main-menu-container')) {
    closeMainMenu();
  }
});

// § New Map / New Pin / Edit Pin — the "Map Menu" (renamed from "New" once
// its second item could be Edit Pin as well as New Pin -- "New" stopped
// describing it accurately), same WAI-ARIA Actions Menu Button pattern as
// Main Menu above (see openMainMenu et al.), just a second, independent
// instance for its own two items. Only shown once a current map exists
// (see showAnchor's one-time UI switch below) -- before that,
// btnNewMapStandalone is the sole entry point, since there's no current
// map to add or edit a pin on yet. The `new-menu-*` id/variable names
// weren't renamed to match -- internal identifiers, not user-facing text,
// same convention as the POI/Pin rename.
function newMenuItems() {
  return Array.from(newMenu.querySelectorAll('[role="menuitem"]')).filter((item) => !item.hidden);
}

// § Edit Pin — the Map Menu's second item is New Pin or Edit Pin depending
// on whether the cursor is currently on a pin, re-evaluated every time the
// menu opens (not kept live while it's closed -- nothing needs to react to
// cursor movement until the menu is actually opened again).
function syncMapMenuPinItem() {
  const poi = currentPoi();
  if (poi) {
    menuNewPin.textContent = 'Edit Pin';
    menuNewPin.title = 'Edit the current pin.';
  } else {
    menuNewPin.textContent = 'New Pin';
    menuNewPin.title = 'Mark a new location on this map.';
  }
}

function openNewMenu(focusIndex) {
  syncMapMenuPinItem();
  newMenu.hidden = false;
  newMenuButton.setAttribute('aria-expanded', 'true');
  focusNewMenuItem(focusIndex);
}

function closeNewMenu({ focusButton = false } = {}) {
  if (newMenu.hidden) return;
  newMenu.hidden = true;
  newMenuButton.setAttribute('aria-expanded', 'false');
  if (focusButton) newMenuButton.focus();
}

function focusNewMenuItem(index) {
  const items = newMenuItems();
  items.forEach((item, i) => item.setAttribute('tabindex', i === index ? '0' : '-1'));
  items[index].focus();
}

newMenuButton.addEventListener('click', () => {
  if (newMenu.hidden) {
    openNewMenu(0);
  } else {
    closeNewMenu();
  }
});

newMenuButton.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openNewMenu(0);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    openNewMenu(newMenuItems().length - 1);
  }
});

Array.from(newMenu.querySelectorAll('[role="menuitem"]')).forEach((item) => {
  item.addEventListener('keydown', (event) => {
    const items = newMenuItems();
    const index = items.indexOf(item);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusNewMenuItem((index + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusNewMenuItem((index - 1 + items.length) % items.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusNewMenuItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusNewMenuItem(items.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeNewMenu({ focusButton: true });
    } else if (event.key === 'Tab') {
      closeNewMenu();
    }
  });
});

document.addEventListener('click', (event) => {
  if (!newMenu.hidden && !event.target.closest('#new-menu-container')) {
    closeNewMenu();
  }
});

btnNewMapStandalone.addEventListener('click', openNewMapDialog);

menuNewMap.addEventListener('click', () => {
  closeNewMenu({ focusButton: true });
  openNewMapDialog();
});

menuNewPin.addEventListener('click', () => {
  closeNewMenu({ focusButton: true });
  openNewOrEditPinDialog();
});

// § Settings — every control in this dialog is live-apply now (a change
// takes effect immediately, not gated behind a commit step): opening the
// dialog only needs to sync each control's displayed value/checked state to
// match current state, and the dialog's own button just dismisses it.
btnSettings.addEventListener('click', () => {
  closeMainMenu({ focusButton: true });
  settingsBrailleCodeSelect.value = brailleCodeSetting;
  settingsUnitsSelect.value = unitSystem;
  settingsPanAmountSelect.value = String(panAmountFraction);
  settingsCursorSoloTimeoutSelect.value = String(cursorSoloTimeoutSeconds);
  for (const zone in labelCheckboxes) labelCheckboxes[zone].checked = labelZones[zone];
  settingsAutoSimplifyCheckbox.checked = autoSimplifyEnabled;
  settingsDialog.showModal();
});
btnSettingsDone.addEventListener('click', () => settingsDialog.close());

settingsBrailleCodeSelect.addEventListener('change', () => {
  brailleCodeSetting = settingsBrailleCodeSelect.value;
  savePersistedSettings();
  // Rebuilds the virtual message window (resets to its first chunk -- see
  // rebuildMessageWindow) and re-sends it, re-encoded under the new
  // setting. The on-screen text/ARIA announcement don't change (nothing
  // about the message itself changed), so this doesn't go through
  // setMessage again, just its device-facing half.
  rebuildMessageWindow(lastMessageText);
  sendCurrentMessageChunkToDevice();
});

// § Settings — switches both the Scale ladder/label (SCALE_PRESETS_M vs.
// SCALE_PRESETS_FT, see refreshScaleOptions/viewportSizeFeet) and how
// anchor-relative distances are reported (see formatDistance). Re-renders
// immediately since the current scale preset's real-world footprint
// changes along with the unit system (an explicit, accepted tradeoff of
// keeping each unit system's scale ladder on clean round numbers).
settingsUnitsSelect.addEventListener('change', () => {
  unitSystem = settingsUnitsSelect.value;
  savePersistedSettings();
  refreshScaleOptions();
  // § Auto Simplification — a Units switch re-renders the map at a new
  // effective real-world footprint for the same scale index (see above),
  // which can change density even though scaleIndex itself didn't move.
  const simplifyLabel = maybeAutoAdjustComplexity();
  refreshMap();
  const unitsLabel = `Units: ${unitSystem === 'metric' ? 'Metric' : 'Imperial'}`;
  setMessage(simplifyLabel ? `${unitsLabel} ${simplifyLabel} visible.` : unitsLabel);
});

// § Pan Behavior / § Settings — a single shared fraction for both
// horizontal and vertical pans (see panMap), not independent per-axis
// settings -- an explicit user decision. No re-render needed: this only
// changes the size of the *next* pan, nothing currently on screen.
settingsPanAmountSelect.addEventListener('change', () => {
  panAmountFraction = Number(settingsPanAmountSelect.value);
  savePersistedSettings();
  setMessage(`Pan amount: ${settingsPanAmountSelect.selectedOptions[0].textContent}`);
});

// § Settings — live-apply, same as every other control here: if cursor-only
// mode is active right now, the change takes effect on its already-running
// timer immediately (restarted under the new duration, or cancelled
// entirely if the new value is "None") rather than waiting for the next
// time cursor-only mode is entered.
settingsCursorSoloTimeoutSelect.addEventListener('change', () => {
  const raw = settingsCursorSoloTimeoutSelect.value;
  cursorSoloTimeoutSeconds = raw === 'none' ? 'none' : Number(raw);
  savePersistedSettings();
  setMessage(`Cursor solo timeout: ${settingsCursorSoloTimeoutSelect.selectedOptions[0].textContent}`);
  if (cursorOnlyMode) startCursorSoloTimer();
});

// § Auto Simplification — turning this on evaluates immediately at
// whatever scale is currently showing (so it has a visible effect right
// away rather than waiting for the next scale change); turning it off
// never changes what's currently displayed, it just stops future
// automatic adjustments until checked again.
settingsAutoSimplifyCheckbox.addEventListener('change', () => {
  autoSimplifyEnabled = settingsAutoSimplifyCheckbox.checked;
  savePersistedSettings();
  const stateLabel = `Automatic simplification: ${autoSimplifyEnabled ? 'on' : 'off'}.`;
  if (autoSimplifyEnabled) {
    const simplifyLabel = maybeAutoAdjustComplexity();
    if (simplifyLabel) refreshMap();
    setMessage(simplifyLabel ? `${stateLabel} ${simplifyLabel} visible.` : stateLabel);
  } else {
    setMessage(stateLabel);
  }
});

// § Help — content lives in its own static file (help-content.html), not
// inline in index.html, specifically so it's easy to hand-edit without
// digging through the rest of the page markup. Fetched once and cached in
// helpContentHtml; every later open reuses the cached copy rather than
// re-fetching. A failed fetch shows an inline error instead of leaving the
// dialog silently blank.
let helpContentHtml = null;

// § Help — shared by the Main Menu item, the footer Help button, and the
// h / ? hotkeys below -- all three open the same dialog the same way.
// Guards against re-opening: the Close button that takes focus inside the
// dialog isn't a form control, so isFormControlFocused() doesn't block the
// hotkeys while Help is already open, and showModal() throws if called on
// a dialog that's already open.
async function openHelpDialog() {
  if (helpDialog.open) return;
  closeMainMenu({ focusButton: true });
  if (helpContentHtml === null) {
    helpContent.textContent = 'Loading help…';
    helpDialog.showModal();
    try {
      const res = await fetch('help-content.html');
      if (!res.ok) throw new Error('help-content-failed');
      helpContentHtml = await res.text();
    } catch (err) {
      helpContent.textContent = 'Could not load help content.';
      return;
    }
  } else {
    helpDialog.showModal();
  }
  helpContent.innerHTML = helpContentHtml;
}

btnHelp.addEventListener('click', openHelpDialog);
btnHelpFooter.addEventListener('click', openHelpDialog);

btnHelpClose.addEventListener('click', () => helpDialog.close());

// § Release Notes — same fetch-once-and-cache pattern as Help above, its own
// static file (release-notes.html) so new entries can be appended without
// touching index.html or app.js.
let releaseNotesHtml = null;

btnReleaseNotes.addEventListener('click', async () => {
  closeMainMenu({ focusButton: true });
  if (releaseNotesHtml === null) {
    releaseNotesContent.textContent = 'Loading release notes…';
    releaseNotesDialog.showModal();
    try {
      const res = await fetch('release-notes.html');
      if (!res.ok) throw new Error('release-notes-failed');
      releaseNotesHtml = await res.text();
    } catch (err) {
      releaseNotesContent.textContent = 'Could not load release notes.';
      return;
    }
  } else {
    releaseNotesDialog.showModal();
  }
  releaseNotesContent.innerHTML = releaseNotesHtml;
});

btnReleaseNotesClose.addEventListener('click', () => releaseNotesDialog.close());

// § Braille labels — shared toggle used by both the dialog checkboxes and
// the i/j/k/l hotkeys. Reports the new state in the message field per
// § Command / hotkey mapping, then re-renders (zone geometry changed).
function setLabelZone(zone, value) {
  if (labelZones[zone] === value) return;
  labelZones[zone] = value;
  savePersistedSettings();
  setMessage(`${zone} labels ${value ? 'on' : 'off'}`);
  refreshMap();
}

function toggleLabelZone(zone) {
  setLabelZone(zone, !labelZones[zone]);
  // Keep the checkbox in sync even if the dialog happens to be open right now.
  labelCheckboxes[zone].checked = labelZones[zone];
}

// § Editing the Map — sets Map Complexity to the given MAP_COMPLEXITY_LEVELS
// index, whether triggered by the 1-4 hotkeys or by picking the radio
// button directly in the Edit Map dialog -- both go through this one
// function so the message field always announces the change (per the
// Message display architecture) and the dialog's own radio stays in sync
// no matter which path triggered it.
function setMapComplexity(index) {
  if (index === mapComplexityIndex) return;
  mapComplexityIndex = index;
  setMessage(`${MAP_COMPLEXITY_LEVELS[index].label} visible.`);
  refreshMap();
  const radio = editMapComplexityList.querySelector(`input[value="${index}"]`);
  if (radio) radio.checked = true;
}

// § Auto Simplification — how much raised-pixel density
// (computeMapDensityPercent) is considered too cluttered to read
// comfortably, confirmed via the experimental d/g density-inspection
// hotkeys.
const AUTO_SIMPLIFY_CRITICAL_PERCENT = 35;

// § Auto Simplification — updates mapComplexityIndex and keeps the Edit
// Map dialog's radio group in sync, the same way setMapComplexity does,
// but deliberately doesn't announce a message or call refreshMap() itself
// -- callers compose their own message by appending the standard
// "[level] visible." text to whatever they're already announcing, and
// call refreshMap() once themselves after the final level is resolved,
// avoiding a double-render/flash of an intermediate level.
function applyAutoComplexityIndex(index) {
  if (index === mapComplexityIndex) return false;
  mapComplexityIndex = index;
  const radio = editMapComplexityList.querySelector(`input[value="${index}"]`);
  if (radio) radio.checked = true;
  return true;
}

// § Auto Simplification — the core algorithm: starting from fromIndex,
// steps toward more simplification if density exceeds the critical value,
// or toward less simplification (more detail) if it doesn't, re-checking
// density at each step. One rule covers both directions the spec
// originally described separately ("when increasing scale" / "when
// decreasing scale"), since density is monotonic in complexity index --
// each level's visible ways are a strict subset of the level before it
// (see § Editing the Map), so simplifying further can only decrease-or-
// hold density, and de-simplifying can only increase-or-hold it.
//
// Escalating toward more simplification stops -- before even checking its
// density -- if the next candidate level would leave literally no street
// visible in the CURRENT VIEWPORT specifically (reusing
// wayIntersectsViewport, built for the Street Abbreviation Key feature),
// not just "no street anywhere in the whole fetched square": a tier
// cutoff can be non-empty overall but empty in what's actually panned
// into view right now. In that case the last level that still showed a
// street is kept, even though it exceeds the critical value -- never
// picking a level that shows nothing at all.
function resolveAutoComplexityIndex(fromIndex) {
  const viewportBbox = getViewportBbox();
  if (!viewportBbox) return fromIndex;

  let index = fromIndex;
  let density = computeMapDensityPercent(index);
  if (density === null) return fromIndex;

  if (density > AUTO_SIMPLIFY_CRITICAL_PERCENT) {
    while (index < MAP_COMPLEXITY_LEVELS.length - 1) {
      const nextIndex = index + 1;
      const hasVisibleStreet = visibleWays(nextIndex).some((way) => wayIntersectsViewport(way, viewportBbox));
      if (!hasVisibleStreet) break;
      index = nextIndex;
      density = computeMapDensityPercent(index);
      if (density <= AUTO_SIMPLIFY_CRITICAL_PERCENT) break;
    }
  } else {
    while (index > 0) {
      const candidateIndex = index - 1;
      const candidateDensity = computeMapDensityPercent(candidateIndex);
      if (candidateDensity > AUTO_SIMPLIFY_CRITICAL_PERCENT) break;
      index = candidateIndex;
    }
  }
  return index;
}

// § Auto Simplification — the single entry point every trigger (a new
// anchor search, a scale change, a Units change, and enabling the setting
// itself) calls. No-op (returns null, nothing changes) if the setting is
// off, Cursor Only mode is active (density reads near-zero with
// everything hidden -- not a meaningful reading), or no map is loaded.
// Returns the new level's label if a change was actually applied (for the
// caller to append to its own message), or null otherwise -- callers
// never call refreshMap()/setMessage from in here; they compose their own
// message and re-render once, after this resolves the final level.
function maybeAutoAdjustComplexity() {
  if (!autoSimplifyEnabled || cursorOnlyMode || !lastBbox) return null;
  const resolvedIndex = resolveAutoComplexityIndex(mapComplexityIndex);
  const changed = applyAutoComplexityIndex(resolvedIndex);
  return changed ? MAP_COMPLEXITY_LEVELS[resolvedIndex].label : null;
}

// § Command / hotkey mapping — the 0 hotkey (also dots 3+5+6 on the Dot
// Pad, see the device key handler below). See cursorOnlyMode above for
// what it does and doesn't affect.
function toggleCursorOnlyMode() {
  cursorOnlyMode = !cursorOnlyMode;
  setMessage(cursorOnlyMode ? 'Cursor only' : 'Features restored');
  refreshMap();
  if (cursorOnlyMode) {
    startCursorSoloTimer();
  } else {
    clearCursorSoloTimer();
  }
}

// § Settings — (re)starts the Cursor Solo Timeout countdown; always clears
// any existing timer first, so calling this again (e.g. the setting
// changing while already in cursor-only mode) restarts fresh under the new
// duration rather than stacking timers. A no-op past the clear if the
// setting is 'none' -- cursor-only mode then only ever ends manually, same
// as before this feature existed.
function startCursorSoloTimer() {
  clearCursorSoloTimer();
  if (cursorSoloTimeoutSeconds === 'none') return;
  cursorSoloTimeoutHandle = setTimeout(() => {
    cursorSoloTimeoutHandle = null;
    if (cursorOnlyMode) toggleCursorOnlyMode();
  }, cursorSoloTimeoutSeconds * 1000);
}

function clearCursorSoloTimer() {
  if (cursorSoloTimeoutHandle !== null) {
    clearTimeout(cursorSoloTimeoutHandle);
    cursorSoloTimeoutHandle = null;
  }
}


// § New Map / New Pin — forceNewAnchor distinguishes the two dialogs'
// Search actions: New Map always wants a fresh anchor regardless of
// distance from whatever's currently showing (per ui cleanup.md); New Pin
// wants today's existing behavior (join the current map, or offer to
// replace it, based on distance from the anchor). Threaded through every
// step of the flow, including the "Did you mean...?" fallback, so picking
// a suggested candidate still honors whichever dialog the search started
// from.
//
// Note: this function's own `query` parameter (the search text) shadows
// the Firestore `query()` import used elsewhere in this file (see
// openMyArchivesDialog) -- never reference the Firestore query function by
// name inside this function's body, it will silently resolve to the
// string parameter instead and throw at call time.
async function runSearch(query, forceNewAnchor) {
  setMessage('Searching…');
  let place;
  try {
    place = await geocode(query);
  } catch (err) {
    setMessage(humanizeOsmError(err, 'address'));
    return;
  }

  if (place) {
    await proceedWithPlace(place, query, forceNewAnchor);
    return;
  }

  // § "Did you mean...?" — geocoding found nothing at all (not a partial
  // match, which geocode() would already have returned as a real place).
  // Falls back to Google Places Text Search, which is far more tolerant of
  // typos/partial names than the Geocoder, and lets the user pick from
  // ranked candidates instead of just failing. If the fallback search
  // itself comes back empty too, that's reported the same as an ordinary
  // no-match -- no dialog, just "No results".
  const candidates = await searchPlacesTextFallback(query);
  if (candidates.length === 0) {
    setMessage('No results');
    return;
  }
  showDidYouMeanDialog(candidates, query, forceNewAnchor);
}

// Shared by a normal successful geocode() and by picking a candidate from
// the "Did you mean...?" dialog -- both end up with a resolved place and
// need to run the exact same anchor/additional-POI/too-far logic (unless
// forceNewAnchor, see runSearch above).
async function proceedWithPlace(place, query, forceNewAnchor) {
  const lat = parseFloat(place.lat);
  const lon = parseFloat(place.lon);
  const displayName = formatPlaceName(place);
  const shortName = formatShortAddress(place);
  // § Analytics — carried through to fetchWays() purely for the
  // overpassLogs country field (see logOverpassQuery). Not available for a
  // loadMapRecord reload, since that has no fresh geocode result.
  const country = (place.address && place.address.country) || null;

  if (forceNewAnchor || !hasAnchor) {
    await createNewAnchor(displayName, shortName, lat, lon, query, country);
    return;
  }

  // § Additional POIs — a location entered after the anchor exists either
  // joins the current map (within the POI distance threshold) or requires
  // discarding it for a new one, depending on distance from the anchor.
  const { eastFt, northFt } = feetOffsetFrom(lat, lon, lastAnchorLat, lastAnchorLon);
  const distFt = Math.hypot(eastFt, northFt);
  const thresholdFt = (POI_DISTANCE_THRESHOLD_MILES * MILES_TO_METERS) / FEET_TO_METERS;

  if (distFt > thresholdFt) {
    promptTooFarPoi(displayName, shortName, lat, lon, distFt, query, country);
    return;
  }

  addAdditionalPoi(shortName, lat, lon);
}

// § "Did you mean...?" — up to 10 ranked candidates as buttons styled to
// read as links (see .candidate-link in style.css); picking one dismisses
// the dialog and proceeds exactly like a normal successful geocode, Cancel
// dismisses it with no further action.
let pendingDidYouMeanQuery = null;
let pendingDidYouMeanForceNewAnchor = false;

function showDidYouMeanDialog(candidates, query, forceNewAnchor) {
  pendingDidYouMeanQuery = query;
  pendingDidYouMeanForceNewAnchor = forceNewAnchor;
  didYouMeanList.innerHTML = '';
  candidates.forEach((candidate) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'candidate-link';
    button.textContent = formatPlaceName(candidate);
    button.addEventListener('click', () => {
      didYouMeanDialog.close();
      const forQuery = pendingDidYouMeanQuery;
      const forForceNewAnchor = pendingDidYouMeanForceNewAnchor;
      pendingDidYouMeanQuery = null;
      pendingDidYouMeanForceNewAnchor = false;
      proceedWithPlace(candidate, forQuery, forForceNewAnchor);
    });
    li.appendChild(button);
    didYouMeanList.appendChild(li);
  });
  didYouMeanDialog.showModal();
}

btnDidYouMeanCancel.addEventListener('click', () => {
  didYouMeanDialog.close();
  pendingDidYouMeanQuery = null;
  pendingDidYouMeanForceNewAnchor = false;
});

// § New Map — opens the dialog that replaces the old always-visible top-
// of-page search field (see ui-cleanup.md). Instructional text is set
// fresh each time the dialog opens rather than being static markup, since
// it depends on whether a current map exists right now (see the doc's
// "The current map will be added to your history" addendum).
function openNewMapDialog() {
  newMapLocationInput.value = '';
  newMapInstructions.textContent = hasAnchor
    ? 'Search for a location. The new map will be centered there. The current map will be added to your history.'
    : 'Search for a location. The new map will be centered there.';
  newMapDialog.showModal();
}

newMapForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = newMapLocationInput.value.trim();
  if (!query) return;
  newMapDialog.close();
  runSearch(query, true);
});

btnNewMapCancel.addEventListener('click', () => newMapDialog.close());

// § POIs — fetches and displays a brand-new anchor, discarding whatever map
// (and additional POIs) may already be showing. Used both for the very
// first search and for "Show new location" when a later search is too far
// from the current anchor to fit on the same map. displayName (the fuller
// name) is used only for the on-screen title and heading; shortName (street
// address only) is what's spoken/brailled everywhere else -- see
// formatShortAddress.
async function createNewAnchor(displayName, shortName, lat, lon, query, country) {
  const bbox = squareBoundingBox(lat, lon, POI_DISTANCE_THRESHOLD_MILES);
  let ways;
  try {
    ways = await fetchWays(bbox, query, country);
  } catch (err) {
    setMessage(humanizeOsmError(err, 'street-data'));
    return;
  }
  // § My Archives — the map about to be discarded gets archived to Map
  // History before any state is overwritten below (fire-and-forget, never
  // blocks the new search -- see archiveOutgoingMapIfNeeded).
  archiveOutgoingMapIfNeeded();
  lastSearchQuery = query;
  additionalPois = [];
  showAnchor(displayName, shortName, lat, lon, bbox, ways);
  renderPoiList();
  saveCurrentMapLocally();
}

// § My Archives — shared by loading a Recent Maps entry, loading a Saved
// Maps entry, and restoring the current map from local storage on
// startup. The map being replaced is archived first, same as
// createNewAnchor (the current map is only ever exempt from archiving
// when there wasn't one yet -- see archiveOutgoingMapIfNeeded's !hasAnchor
// guard, which correctly no-ops on the very first page load). The record
// being loaded, on the other hand, never itself touches Map History or
// Saved Maps just by being loaded -- only restores additionalPois/
// hiddenPoiNames/hiddenStreetNames/viewport instead of resetting them.
// Complexity/cursor-only/scale/braille aren't part of a record, so they
// come out exactly as showAnchor's normal reset leaves them -- correct,
// since those are display preferences, not map data.
//
// cachedWays, if given, skips the Overpass fetch entirely -- only the
// startup current-map restore (see bottom of file) ever passes this;
// Map History and Saved Maps entries always call this with no second
// argument, so they always fetch live, regardless of what's sitting in
// the current-map ways cache.
async function loadMapRecord(record, cachedWays) {
  const bbox = squareBoundingBox(record.anchorLat, record.anchorLon, POI_DISTANCE_THRESHOLD_MILES);
  let ways;
  if (cachedWays) {
    ways = cachedWays;
  } else {
    try {
      // No fresh geocode result here (this is a saved-map reload, not a new
      // search) -- overpassLogs' country field is left null for this call.
      ways = await fetchWays(bbox, record.searchQuery, null);
    } catch (err) {
      setMessage(humanizeOsmError(err, 'street-data'));
      return;
    }
  }
  archiveOutgoingMapIfNeeded();
  lastSearchQuery = record.searchQuery || null;
  showAnchor(record.anchorName, record.anchorName, record.anchorLat, record.anchorLon, bbox, ways);
  additionalPois = (record.additionalPois || []).map((poi) => ({ ...poi }));
  hiddenPoiNames = new Set(record.hiddenPoiNames || []);
  hiddenStreetNames = new Set(record.hiddenStreetNames || []);
  if (typeof record.viewportCenterLat === 'number' && typeof record.viewportCenterLon === 'number') {
    viewportCenterLat = record.viewportCenterLat;
    viewportCenterLon = record.viewportCenterLon;
  }
  renderPoiList();
  refreshMap();
  saveCurrentMapLocally();
}

// § My Archives — deep-equality check between two captureCurrentMap()-
// shaped records (ignoring metadata like updatedAt/doc id), used to decide
// whether replacing the current map is genuinely a new map or just the
// same location searched again (see archiveOutgoingMapIfNeeded).
function isSameMap(a, b) {
  const normalize = (m) => JSON.stringify({
    anchorName: m.anchorName,
    anchorLat: m.anchorLat,
    anchorLon: m.anchorLon,
    additionalPois: m.additionalPois,
    hiddenPoiNames: [...(m.hiddenPoiNames || [])].sort(),
    hiddenStreetNames: [...(m.hiddenStreetNames || [])].sort(),
    viewportCenterLat: m.viewportCenterLat,
    viewportCenterLon: m.viewportCenterLon
  });
  return normalize(a) === normalize(b);
}

// § My Archives — Map History cap; called after every append so the
// collection never grows past RECENT_MAPS_LIMIT. Firestore has no
// built-in cap, so this is enforced client-side: fetch newest-first,
// delete anything past the limit.
const RECENT_MAPS_LIMIT = 10;

async function pruneRecentMaps() {
  const historyRef = collection(db, 'users', currentUser.uid, 'recentMaps');
  const snapshot = await getDocs(query(historyRef, orderBy('updatedAt', 'desc')));
  const overflow = snapshot.docs.slice(RECENT_MAPS_LIMIT);
  await Promise.all(overflow.map((docSnap) => deleteDoc(docSnap.ref)));
}

// § My Archives — the current map is only archived to Map History at the
// moment it's about to be replaced by a genuinely new one (see
// createNewAnchor). Fire-and-forget: an archiving failure must never
// block the new search. No-ops silently
// while signed out or when there's no outgoing map yet (the very first
// search). If the outgoing map is identical to the top of the existing
// history (e.g. the same location searched again), only that entry's
// timestamp is refreshed rather than creating a duplicate.
async function archiveOutgoingMapIfNeeded() {
  if (!hasAnchor || !currentUser) return;
  try {
    const outgoing = captureCurrentMap();
    const historyRef = collection(db, 'users', currentUser.uid, 'recentMaps');
    const topSnap = await getDocs(query(historyRef, orderBy('updatedAt', 'desc'), limit(1)));
    if (!topSnap.empty && isSameMap(topSnap.docs[0].data(), outgoing)) {
      await updateDoc(topSnap.docs[0].ref, { updatedAt: serverTimestamp() });
      return;
    }
    await addDoc(historyRef, { ...outgoing, updatedAt: serverTimestamp() });
    await pruneRecentMaps();
  } catch (err) {
    console.warn('map history archive failed', err);
  }
}

// § Additional POIs — "The new location is [distance] away from [anchor
// POI]. That's too far away for a single map." Confirming discards the
// current map and makes the new location the anchor; cancelling leaves the
// current map untouched.
function promptTooFarPoi(displayName, shortName, lat, lon, distFt, query, country) {
  pendingFarPoi = { displayName, shortName, lat, lon, query, country };
  poiTooFarMessage.textContent =
    `The new location is ${formatDistance(distFt)} away from ${lastAnchorName}. ` +
    `That's too far away for a single map.`;
  btnPoiShowAnyway.textContent = `Show ${shortName}`;
  poiTooFarDialog.showModal();
}

btnPoiShowAnyway.addEventListener('click', () => {
  poiTooFarDialog.close();
  const pending = pendingFarPoi;
  pendingFarPoi = null;
  if (pending) createNewAnchor(pending.displayName, pending.shortName, pending.lat, pending.lon, pending.query, pending.country);
});
btnPoiCancel.addEventListener('click', () => {
  poiTooFarDialog.close();
  pendingFarPoi = null;
});

// § Additional POIs — adds a triangle-marker POI to the current map, then
// pans to center it and moves the cursor there (announcing distance/
// direction from the anchor, same as an explicit pan).
function addAdditionalPoi(shortName, lat, lon) {
  additionalPois.push({ name: compactedDisplayName(shortName), lat, lon });
  renderPoiList();
  panToPoint(lat, lon);
  saveCurrentMapLocally();
}

// § Drop Pin — dots-to-feet conversion at the current Scale, used to turn
// the fixed-in-dots CURSOR_HIT_RADIUS into a real-world nearby-places
// search radius that shrinks/grows with zoom (an explicit user decision).
// Independent of active label zones: viewportSizeFeet's width/height both
// scale with mapGridBounds' shrunk dot count proportionally, so the ratio
// between real-world feet and dots cancels back out to this same value
// regardless of which zones are active -- only the total visible area
// changes with zones, not this per-dot ratio.
function feetPerDot() {
  const inchesPerDot = DOT_PAD_DISPLAY_WIDTH_INCHES / DOT_GRID_WIDTH;
  if (unitSystem === 'metric') {
    return (SCALE_PRESETS_M[scaleIndex] * inchesPerDot * CM_PER_INCH) / FEET_TO_METERS;
  }
  return SCALE_PRESETS_FT[scaleIndex] * inchesPerDot;
}

// § Drop Pin — nearby-place candidates come from Google now, not Overpass
// (which was often slow and frequently returned nothing at all for this
// small a radius): a Places API (New) nearby search for named businesses/
// amenities within CURSOR_HIT_RADIUS (converted to real-world feet via
// feetPerDot, then to meters -- same scale-dependent radius as before),
// plus a Geocoder reverse lookup at the same point for the nearest street
// address, since Places' nearby search returns businesses/POIs but not
// bare street addresses. The two run in parallel; either failing alone
// just contributes nothing (the other's results still show), and only
// both failing surfaces as an error to the caller. Returns a sorted,
// deduplicated array of candidate name strings -- names only, since Drop
// Pin always places the new POI at the cursor's own position regardless
// of which suggestion is picked (see openCustomPoiDialog below).
async function fetchNearbyPoiCandidateNames(lat, lon) {
  await loadGoogleMaps();
  const radiusMeters = Math.max(1, CURSOR_HIT_RADIUS * feetPerDot() * FEET_TO_METERS);

  const placesPromise = google.maps.places.Place.searchNearby({
    locationRestriction: { center: { lat, lng: lon }, radius: radiusMeters },
    fields: ['displayName'],
    maxResultCount: 20
  }).then(({ places }) => (places || []).map((p) => p.displayName).filter(Boolean));

  // Reverse geocode gives the nearest address to the point, not strictly
  // one inside the radius -- accepted: "the closest address to the cursor"
  // is exactly what a user dropping a pin at an unnamed spot wants.
  const addressPromise = new google.maps.Geocoder()
    .geocode({ location: { lat, lng: lon } })
    .then((response) => {
      const first = response.results && response.results[0];
      if (!first) return [];
      const components = {};
      for (const component of first.address_components || []) {
        for (const type of component.types) components[type] = component.long_name;
      }
      const streetLine = [components.street_number, components.route].filter(Boolean).join(' ');
      return streetLine ? [streetLine] : [];
    });

  const settled = await Promise.allSettled([placesPromise, addressPromise]);
  if (settled.every((r) => r.status === 'rejected')) {
    console.error('nearby POI lookup failed:', settled[0].reason, settled[1].reason);
    throw new Error('nearby-poi-failed');
  }
  const names = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

// § Drop Pin — the current dialog session's candidate list and navigation
// position (see the input's own keydown handler below). customPoiRequestToken
// guards against a slow Google response from an earlier Drop Pin
// invocation landing after the dialog's been reopened (or the map panned/
// rescaled) for a new one -- only the response matching the token issued at
// the time of the *current* invocation is applied. customPoiUserTyped
// tracks whether the user has typed into the field since the dialog
// opened (set by a real 'input' event, which programmatic .value writes
// never fire): if they beat the network response, the arriving first
// candidate must not clobber their text -- the candidates just sit ready
// for Up/Down navigation instead.
let customPoiCandidates = [];
let customPoiCandidateIndex = -1;
let customPoiRequestToken = 0;
let customPoiUserTyped = false;

// Populates the edit field with a candidate name and selects it, so
// simply starting to type replaces the suggestion instead of appending to
// it. Used both for the initial auto-fill and for Up/Down stepping.
function setCustomPoiFieldToCandidate(index) {
  customPoiCandidateIndex = index;
  customPoiNameInput.value = customPoiCandidates[index];
  customPoiNameInput.select();
}

// § Additional POIs — "Drop Pin" adds a custom, user-named POI at the
// cursor's current position, via the same addAdditionalPoi path as any
// other POI -- so it shows up in the POI dropdown, the Edit Map dialog,
// rendering, hit-testing, and the tactile raster exactly like a
// search-added POI, with no separate plumbing needed. The dialog's
// suggested name candidates (below) only ever influence what text starts
// out in the edit field -- confirming with OK always places the new POI
// at the cursor's own position (per an explicit user decision), never at
// a suggested candidate's own (possibly slightly different) coordinates.
// Guarded on hasAnchor here (rather than only via the New menu's own
// visibility) since the p/a hotkeys below can reach this directly without
// going through the menu at all -- there's no cursor position to drop a
// pin at, or map to search on, before a first map exists.
async function openCustomPoiDialog() {
  if (!hasAnchor) return;
  const token = ++customPoiRequestToken;
  customPoiCandidates = [];
  customPoiCandidateIndex = -1;
  customPoiUserTyped = false;
  customPoiNameInput.value = '';
  customPoiStatus.textContent = 'Loading nearby places…';
  customPoiDialog.showModal();

  let names;
  try {
    names = await fetchNearbyPoiCandidateNames(cursorLat, cursorLon);
  } catch (err) {
    if (token === customPoiRequestToken) customPoiStatus.textContent = 'Could not load nearby places.';
    return;
  }
  if (token !== customPoiRequestToken) return;

  customPoiCandidates = names;
  if (customPoiCandidates.length) {
    customPoiStatus.textContent = '';
    // Auto-fill the first candidate only if the user hasn't already begun
    // typing a name of their own while the lookup was in flight; if they
    // have, leave their text alone (candidateIndex stays -1, so the first
    // Down-arrow press starts from candidate 0).
    if (!customPoiUserTyped) setCustomPoiFieldToCandidate(0);
  } else {
    customPoiStatus.textContent = 'No nearby places found.';
  }
}

customPoiNameInput.addEventListener('input', () => { customPoiUserTyped = true; });

// § Drop Pin — Up/Down step through customPoiCandidates without wrapping
// (a no-op at either end), populating the edit field with each candidate's
// name in turn, selected (see setCustomPoiFieldToCandidate) so typing
// replaces it. preventDefault on both -- neither has a native meaning in a
// single-line text input, but this keeps them from doing anything
// unexpected. Global map hotkeys (including cursor movement) are already
// blocked while this input has focus, per isFormControlFocused's existing
// INPUT/SELECT/TEXTAREA check -- no separate guarding needed here for that.
customPoiNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (customPoiCandidateIndex < customPoiCandidates.length - 1) {
      setCustomPoiFieldToCandidate(customPoiCandidateIndex + 1);
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (customPoiCandidateIndex > 0) {
      setCustomPoiFieldToCandidate(customPoiCandidateIndex - 1);
    }
  }
});

customPoiForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = customPoiNameInput.value.trim();
  if (!name) return;
  customPoiDialog.close();
  addAdditionalPoi(name, cursorLat, cursorLon);
});

// § New Pin — the alternative to dropping a named pin at the cursor:
// search for a location elsewhere on the map instead, using whatever text
// is currently in the same name field. Runs the same additional-pin/
// too-far logic as before this dialog existed (forceNewAnchor false) --
// only New Map's own Search button always replaces the current map.
btnCustomPoiSearch.addEventListener('click', () => {
  const query = customPoiNameInput.value.trim();
  if (!query) return;
  customPoiDialog.close();
  runSearch(query, false);
});

btnCustomPoiCancel.addEventListener('click', () => customPoiDialog.close());

// § Edit Pin — currently-open target, set by openEditPinDialog and read by
// the form/Delete handlers below; { isAnchor, index, name, lat, lon }, same
// shape currentPoi() returns.
let editPinTarget = null;

// § Edit Pin — replaces New Pin whenever the cursor is already on a pin:
// New Pin and Edit Pin are never available at the same time (there's
// either a pin under the cursor or there isn't), so p/a and the Map
// Menu's pin item can safely share one dispatcher between the two dialogs.
function openNewOrEditPinDialog() {
  const poi = currentPoi();
  if (poi) {
    openEditPinDialog(poi);
  } else {
    openCustomPoiDialog();
  }
}

// § Edit Pin — guarded on its own open state the same way openHelpDialog()
// is: the OK/Cancel/Delete buttons aren't form controls, so if focus has
// moved off the name input (which normally blocks p/a as a form control)
// onto one of them, a repeat p/a press would otherwise call showModal() on
// an already-open dialog and throw.
function openEditPinDialog(poi) {
  if (editPinDialog.open) return;
  editPinTarget = poi;
  editPinNameInput.value = poi.name;
  editPinInstructions.textContent = poi.isAnchor
    ? "To update the pin name, press OK, or press Cancel to leave it unchanged."
    : "To update the pin name, press OK, or press Cancel to leave it unchanged. Pressing 'Delete Pin' will permanently remove this pin from the map.";
  btnEditPinDelete.hidden = poi.isAnchor;
  editPinDialog.showModal();
}

// § Edit Pin — OK: renames the anchor or the target additionalPois entry.
// Compacted the same way every other pin name is at creation time (see
// addAdditionalPoi/showAnchor) so a freeform name like "Home" passes
// through unchanged while a real address-like name still gets compacted.
// Renaming the anchor also updates the H2 heading and tab title (Josh's
// call): the pin name is the single source of truth for how the anchor is
// presented everywhere, not just in the pin-navigation list.
editPinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const newName = compactedDisplayName(editPinNameInput.value.trim());
  if (!newName) return;
  editPinDialog.close();
  if (editPinTarget.isAnchor) {
    lastAnchorName = newName;
    anchorHeading.textContent = newName;
    document.title = `DotTMAP — ${newName}`;
  } else {
    additionalPois[editPinTarget.index].name = newName;
  }
  renderPoiList();
  refreshMap();
  saveCurrentMapLocally();
  setMessage(`${newName} renamed.`);
});

btnEditPinCancel.addEventListener('click', () => editPinDialog.close());

// § Edit Pin — Delete Pin: permanently removes the target from
// additionalPois (never shown for the anchor -- btnEditPinDelete stays
// hidden in that case, see openEditPinDialog). Deliberately different
// from Edit Map's pin removal, which only hides a pin (reversible via
// Hidden Features) -- this splices it out entirely, per Josh's explicit
// "permanently remove" wording for this dialog.
btnEditPinDelete.addEventListener('click', () => {
  const { index, name } = editPinTarget;
  additionalPois.splice(index, 1);
  editPinDialog.close();
  renderPoiList();
  refreshMap();
  saveCurrentMapLocally();
  setMessage(`${name} deleted.`);
});

// § POIs — the anchor is always the first entry (value "anchor"), followed
// by every additional POI (value = its index into additionalPois).
// § Editing the Map — a POI hidden via the Edit Map dialog is left out of
// this nav list too (it's no longer "on the map" to pan to), but option
// values for additional POIs still carry their real additionalPois index,
// not a position within this filtered list -- the change handler below
// indexes additionalPois directly.
function renderPoiList() {
  poiListSelect.innerHTML = '';
  if (lastAnchorName && !hiddenPoiNames.has(lastAnchorName)) {
    const anchorOption = document.createElement('option');
    anchorOption.value = 'anchor';
    anchorOption.textContent = lastAnchorName;
    poiListSelect.appendChild(anchorOption);
  }
  additionalPois.forEach((poi, index) => {
    if (hiddenPoiNames.has(poi.name)) return;
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = poi.name;
    poiListSelect.appendChild(option);
  });
  poiListSelect.disabled = !lastAnchorName;
  btnGotoPin.hidden = !lastAnchorName;
}

// § Additional POIs — pans to whatever POI is currently selected in the
// list box, announcing just its name rather than a distance/direction
// from the anchor -- navigating among already-known POIs is a "go to X"
// action, not a "how far is X" one, unlike an explicit pan or a newly
// added POI (see panToPoint).
function panToSelectedPoi() {
  if (poiListSelect.value === 'anchor') {
    moveViewportAndCursorTo(lastAnchorLat, lastAnchorLon);
    setMessage(lastAnchorName);
    return;
  }
  const poi = additionalPois[Number(poiListSelect.value)];
  if (poi) {
    moveViewportAndCursorTo(poi.lat, poi.lon);
    setMessage(poi.name);
  }
}

// § Additional POIs — "Selecting an item from the list box (or arrowing
// through the list) pans to that POI." A native <select> already fires
// 'change' on every arrow-key move, not just on a committed selection, so
// this alone covers both interactions -- except when the list has only
// one entry (just the anchor, no additional POIs added yet): a
// single-option select can never fire 'change', since there's nothing
// else to select. Focusing it (by tabbing to it or clicking it) is the
// only signal available in that case, so it gets the same snap-to-POI
// treatment there.
poiListSelect.addEventListener('change', panToSelectedPoi);
poiListSelect.addEventListener('focus', () => {
  if (poiListSelect.options.length === 1) panToSelectedPoi();
});

// § Additional POIs — moves the list box's own selection forward/backward
// (direction = +1/-1), wrapping at either end (advancing past the last
// entry lands on the first, and vice versa -- unlike the list box's own
// native arrow-key behavior, which clamps), then applies the same
// pan-to-selection behavior a change event would. Called explicitly
// rather than relying on 'change' since setting selectedIndex
// programmatically never fires it -- this is also what makes the . / ,
// hotkeys and dot4/dot1 below work correctly with only the anchor in the
// list, same as the list box's own focus-triggered snap-back.
function navigatePoiList(direction) {
  const count = poiListSelect.options.length;
  if (poiListSelect.disabled || count === 0) return;
  poiListSelect.selectedIndex = (poiListSelect.selectedIndex + direction + count) % count;
  panToSelectedPoi();
}

// § Additional POIs — Goto Pin button, a mouse-only affordance replacing
// the on-screen Pins list box (now hidden, see #poi-list-container in
// index.html) for sighted users who don't know the ./, hotkeys or
// dot4/dot1. One direction only, same as those keys' forward step.
btnGotoPin.addEventListener('click', () => navigatePoiList(1));

// § Editing the Map — every street/pathway name currently in lastWays
// (regardless of hidden state -- the dialog must still list a hidden
// feature so it can be turned back on), merged into one alphabetical list
// regardless of way class. The old Streets/Pedestrian Pathways split
// (classified per-way, not per-name) is gone along with its sync quirk --
// Visible/Hidden Streets are both keyed by name alone now, same as
// hiddenStreetNames itself.
function collectStreetNames() {
  const names = new Set();
  for (const way of lastWays) {
    const name = way.tags && way.tags.name;
    if (name) names.add(name);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

// § Editing the Map — fills one group's list with a clickable button per
// item (no checkboxes -- section membership alone conveys visible/hidden
// state, so a checkbox would be redundant). Each item is { name, kind };
// kind is only meaningful in Hidden Features (see collectHiddenFeatures),
// where it's needed to route a restore back to the right home section.
function populateEditMapButtons(listContainer, items, idPrefix) {
  listContainer.innerHTML = '';
  if (items.length === 0) {
    const none = document.createElement('p');
    none.textContent = '(none)';
    listContainer.appendChild(none);
    return;
  }
  items.forEach(({ name, kind }, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${idPrefix}-${index}`;
    button.textContent = name;
    button.dataset.name = name;
    if (kind) button.dataset.kind = kind;
    listContainer.appendChild(button);
  });
}

function editMapButtons(listContainer) {
  return [...listContainer.querySelectorAll('button')];
}

// § Editing the Map — after a toggle, focus stays in the section it came
// from, landing on whatever item now sits at the same position (the next
// item, or the previous one if it was last) -- not on the item's new
// location. Only falls back to destList (focusing this name's button
// there) if sourceList is now completely empty. Shared by POIs, Visible
// Streets, and Hidden Features so all three sections behave the same way.
function focusAfterEditMapToggle(sourceList, sourceIndex, destList, name) {
  const remaining = editMapButtons(sourceList);
  if (remaining.length > 0) {
    remaining[Math.min(sourceIndex, remaining.length - 1)].focus();
  } else {
    const moved = editMapButtons(destList).find((b) => b.dataset.name === name);
    if (moved) moved.focus();
  }
}

// § Editing the Map — currently-visible POIs, as buttons for the POIs
// section. Re-run after any POI hide/restore.
function renderEditMapPois() {
  const items = allPois().filter((poi) => !hiddenPoiNames.has(poi.name)).map((poi) => ({ name: poi.name }));
  populateEditMapButtons(editMapPoisList, items, 'edit-map-poi');
}

// § Editing the Map — currently-visible streets, as buttons for the
// Visible Streets section. Re-run after any street hide/restore.
function renderVisibleStreets() {
  const items = collectStreetNames().filter((name) => !hiddenStreetNames.has(name)).map((name) => ({ name }));
  populateEditMapButtons(editMapVisibleStreetsList, items, 'edit-map-visible-street');
}

// § Editing the Map — Hidden Features combines hidden POIs and hidden
// streets into one list (per user request -- a shared destination for
// anything hidden, not two parallel hidden-POIs/hidden-streets sections).
// Hidden POIs are listed first (in their normal POI order -- anchor, then
// additional POIs in add order), hidden streets alphabetically after.
function renderHiddenFeatures() {
  const hiddenPois = allPois()
    .filter((poi) => hiddenPoiNames.has(poi.name))
    .map((poi) => ({ name: poi.name, kind: 'poi' }));
  const hiddenStreets = collectStreetNames()
    .filter((name) => hiddenStreetNames.has(name))
    .map((name) => ({ name, kind: 'street' }));
  populateEditMapButtons(editMapHiddenFeaturesList, [...hiddenPois, ...hiddenStreets], 'edit-map-hidden-feature');
}

// § Editing the Map — clicking a visible POI removes it: hides it (moves
// it into Hidden Features), refreshes the map and the on-screen POI
// dropdown, and applies the shared focus rule above.
function handlePoiButtonClick(event) {
  const button = event.target;
  if (!button.matches('button')) return;
  const name = button.dataset.name;
  const sourceIndex = editMapButtons(editMapPoisList).indexOf(button);
  hiddenPoiNames.add(name);
  renderEditMapPois();
  renderHiddenFeatures();
  renderPoiList();
  refreshMap();
  setMessage(`${name} removed`);
  focusAfterEditMapToggle(editMapPoisList, sourceIndex, editMapHiddenFeaturesList, name);
  saveCurrentMapLocally();
}

editMapPoisList.addEventListener('click', handlePoiButtonClick);

// § Editing the Map — clicking a visible street removes it: hides it
// (moves it into Hidden Features), refreshes the map, and applies the
// shared focus rule above.
function handleVisibleStreetButtonClick(event) {
  const button = event.target;
  if (!button.matches('button')) return;
  const name = button.dataset.name;
  const sourceIndex = editMapButtons(editMapVisibleStreetsList).indexOf(button);
  hiddenStreetNames.add(name);
  renderVisibleStreets();
  renderHiddenFeatures();
  refreshMap();
  setMessage(`${name} removed`);
  focusAfterEditMapToggle(editMapVisibleStreetsList, sourceIndex, editMapHiddenFeaturesList, name);
  saveCurrentMapLocally();
}

editMapVisibleStreetsList.addEventListener('click', handleVisibleStreetButtonClick);

// § Editing the Map — clicking a Hidden Features item restores it to its
// home section (POIs or Visible Streets, per its kind), refreshes the map
// (and the POI dropdown, for a POI), and applies the shared focus rule.
function handleHiddenFeatureButtonClick(event) {
  const button = event.target;
  if (!button.matches('button')) return;
  const name = button.dataset.name;
  const kind = button.dataset.kind;
  const sourceIndex = editMapButtons(editMapHiddenFeaturesList).indexOf(button);
  if (kind === 'poi') {
    hiddenPoiNames.delete(name);
    renderEditMapPois();
    renderPoiList();
  } else {
    hiddenStreetNames.delete(name);
    renderVisibleStreets();
  }
  renderHiddenFeatures();
  refreshMap();
  setMessage(`${name} restored`);
  const destList = kind === 'poi' ? editMapPoisList : editMapVisibleStreetsList;
  focusAfterEditMapToggle(editMapHiddenFeaturesList, sourceIndex, destList, name);
  saveCurrentMapLocally();
}

editMapHiddenFeaturesList.addEventListener('click', handleHiddenFeatureButtonClick);

// § Editing the Map — Map Complexity radio group, one row per
// MAP_COMPLEXITY_LEVELS entry (see setMapComplexity for what picking one
// does).
function populateEditMapComplexity(listContainer) {
  listContainer.innerHTML = '';
  MAP_COMPLEXITY_LEVELS.forEach((level, index) => {
    const id = `edit-map-complexity-${index}`;
    const row = document.createElement('div');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'map-complexity';
    radio.id = id;
    radio.value = String(index);
    radio.checked = index === mapComplexityIndex;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = level.label;
    row.appendChild(radio);
    row.appendChild(label);
    listContainer.appendChild(row);
  });
}

editMapComplexityList.addEventListener('change', (event) => {
  const radio = event.target;
  if (!radio.matches('input[type="radio"]')) return;
  setMapComplexity(Number(radio.value));
});

// § Editing the Map — rebuilt from current map data every time the dialog
// opens, so it always reflects whatever's actually on the map (including
// features added since the dialog was last open). No Save/Cancel step --
// every button/radio here applies immediately (see handlePoiButtonClick,
// handleVisibleStreetButtonClick, handleHiddenFeatureButtonClick,
// setMapComplexity).
function openEditMapDialog() {
  renderEditMapPois();
  renderVisibleStreets();
  renderHiddenFeatures();
  populateEditMapComplexity(editMapComplexityList);
  editMapDialog.showModal();
}

btnEditMap.addEventListener('click', () => {
  if (btnEditMap.getAttribute('aria-disabled') === 'true') return;
  closeMainMenu({ focusButton: true });
  openEditMapDialog();
});

btnEditMapClose.addEventListener('click', () => editMapDialog.close());

// § My Archives — "local, concise" date/time formatting shared by Recent
// Maps and Saved Maps (e.g. "Jan 21, 2026, 14:45"). Uses the Date object's
// own local-time getters, so this always reflects the viewer's own clock.
const MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateTime(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${MONTH_ABBREVIATIONS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}, ${hh}:${mm}`;
}

function poiCountFor(record) {
  return (record.additionalPois || []).length + 1;
}

function hiddenCountFor(record) {
  return (record.hiddenPoiNames || []).length + (record.hiddenStreetNames || []).length;
}

// § My Archives — Saved Maps CRUD. name/notes are user-editable; the map
// data itself is a frozen snapshot from the moment of saving (loading a
// saved map, or later changing the current map, never writes back to it).
async function saveCurrentMapAs(name, notes) {
  await addDoc(collection(db, 'users', currentUser.uid, 'savedMaps'), {
    ...captureCurrentMap(),
    name,
    notes,
    savedAt: serverTimestamp()
  });
}

async function updateSavedMapNameNotes(docId, name, notes) {
  await updateDoc(doc(db, 'users', currentUser.uid, 'savedMaps', docId), { name, notes });
}

async function deleteSavedMap(docId) {
  await deleteDoc(doc(db, 'users', currentUser.uid, 'savedMaps', docId));
}

// § My Archives — empties Map History only; Saved Maps is a separate
// collection and untouched.
async function clearRecentMapsHistory() {
  const snapshot = await getDocs(collection(db, 'users', currentUser.uid, 'recentMaps'));
  await Promise.all(snapshot.docs.map((docSnap) => deleteDoc(docSnap.ref)));
}

// § My Archives — the top row of Recent Maps is synthesized live from the
// current (local-only) map rather than a Firestore document -- there's
// nothing useful to "load" since it's already showing, so unlike the rows
// below it, this one is plain text, not a link.
function buildCurrentMapRow() {
  const tr = document.createElement('tr');
  const nameTd = document.createElement('td');
  const dateTd = document.createElement('td');
  const poisTd = document.createElement('td');
  const hiddenTd = document.createElement('td');
  if (hasAnchor) {
    nameTd.textContent = `${lastAnchorName} (current)`;
    const local = loadPersistedCurrentMap();
    dateTd.textContent = local && local.updatedAt ? formatDateTime(new Date(local.updatedAt)) : '';
    poisTd.textContent = String(allPois().length);
    hiddenTd.textContent = String(hiddenPoiNames.size + hiddenStreetNames.size);
  } else {
    nameTd.textContent = '(no current map)';
  }
  tr.append(nameTd, dateTd, poisTd, hiddenTd);
  return tr;
}

function buildEmptyRow(colSpan, text) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colSpan;
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

async function renderRecentMapsSection() {
  recentMapsBody.textContent = '';
  recentMapsBody.appendChild(buildCurrentMapRow());
  if (!currentUser) {
    recentMapsBody.appendChild(buildEmptyRow(4, 'Sign in to keep a history of past maps.'));
    btnClearHistory.hidden = true;
    return;
  }
  btnClearHistory.hidden = false;
  try {
    const historyQuery = query(collection(db, 'users', currentUser.uid, 'recentMaps'), orderBy('updatedAt', 'desc'));
    const snapshot = await getDocs(historyQuery);
    snapshot.forEach((docSnap) => {
      const record = docSnap.data();
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.textContent = record.anchorName;
      nameBtn.addEventListener('click', () => {
        myArchivesDialog.close();
        loadMapRecord(record);
      });
      nameTd.appendChild(nameBtn);
      const dateTd = document.createElement('td');
      dateTd.textContent = record.updatedAt ? formatDateTime(record.updatedAt.toDate()) : '';
      const poisTd = document.createElement('td');
      poisTd.textContent = String(poiCountFor(record));
      const hiddenTd = document.createElement('td');
      hiddenTd.textContent = String(hiddenCountFor(record));
      tr.append(nameTd, dateTd, poisTd, hiddenTd);
      recentMapsBody.appendChild(tr);
    });
  } catch (err) {
    recentMapsBody.appendChild(buildEmptyRow(4, 'Could not load Map History.'));
  }
}

// § My Archives — fetched once per dialog open, re-sorted client-side by
// clicking the Name/Date column headers (no need for a second Firestore
// query). savedMapsSortKey persists across re-renders within the same
// dialog session, same as radio buttons would have.
let savedMapsCache = [];
let savedMapsSortKey = 'date';

function sortedSavedMaps() {
  const sorted = [...savedMapsCache];
  if (savedMapsSortKey === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    sorted.sort((a, b) => (b.savedAt ? b.savedAt.toMillis() : 0) - (a.savedAt ? a.savedAt.toMillis() : 0));
  }
  return sorted;
}

function renderSavedMapsTable() {
  savedMapsBody.textContent = '';
  if (!currentUser) {
    savedMapsBody.appendChild(buildEmptyRow(6, 'Sign in to save and view your saved maps.'));
    return;
  }
  if (savedMapsCache.length === 0) {
    savedMapsBody.appendChild(buildEmptyRow(6, 'No saved maps yet.'));
    return;
  }
  sortedSavedMaps().forEach((record) => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.textContent = record.name;
    nameBtn.addEventListener('click', () => {
      myArchivesDialog.close();
      loadMapRecord(record);
    });
    nameTd.appendChild(nameBtn);
    const dateTd = document.createElement('td');
    dateTd.textContent = record.savedAt ? formatDateTime(record.savedAt.toDate()) : '';
    const poisTd = document.createElement('td');
    poisTd.textContent = String(poiCountFor(record));
    const hiddenTd = document.createElement('td');
    hiddenTd.textContent = String(hiddenCountFor(record));
    const notesTd = document.createElement('td');
    notesTd.textContent = record.notes || '';
    const actionsTd = document.createElement('td');
    const actionsBtn = document.createElement('button');
    actionsBtn.type = 'button';
    actionsBtn.className = 'row-actions-button';
    actionsBtn.textContent = 'Actions';
    actionsBtn.setAttribute('aria-haspopup', 'true');
    actionsBtn.setAttribute('aria-expanded', 'false');
    actionsBtn.addEventListener('click', () => openRowActionsMenu(actionsBtn, record));
    actionsTd.appendChild(actionsBtn);
    tr.append(nameTd, dateTd, poisTd, hiddenTd, notesTd, actionsTd);
    savedMapsBody.appendChild(tr);
  });
}

async function refreshSavedMapsSection() {
  btnSaveCurrentMap.hidden = !currentUser;
  if (currentUser) {
    if (hasAnchor) btnSaveCurrentMap.removeAttribute('aria-disabled');
    else btnSaveCurrentMap.setAttribute('aria-disabled', 'true');
  }
  if (!currentUser) {
    savedMapsCache = [];
    renderSavedMapsTable();
    return;
  }
  try {
    const snapshot = await getDocs(collection(db, 'users', currentUser.uid, 'savedMaps'));
    savedMapsCache = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  } catch (err) {
    savedMapsCache = [];
  }
  renderSavedMapsTable();
}

async function openMyArchivesDialog() {
  await Promise.all([renderRecentMapsSection(), refreshSavedMapsSection()]);
  myArchivesDialog.showModal();
}

btnMyArchives.addEventListener('click', () => {
  closeMainMenu({ focusButton: true });
  openMyArchivesDialog();
});

btnMyArchivesDone.addEventListener('click', () => myArchivesDialog.close());

btnClearHistory.addEventListener('click', async () => {
  if (!currentUser) return;
  try {
    await clearRecentMapsHistory();
  } catch (err) {
    console.error('clear history failed', err);
    setMessage('Clear History failed');
  }
  renderRecentMapsSection();
});

// § My Archives — clickable column headers replace what would otherwise
// be separate sort radio buttons; aria-sort on each <th> communicates the
// active column/direction to screen readers the same way a checked radio
// would have.
function setSavedMapsSortKey(key) {
  savedMapsSortKey = key;
  savedMapsSortName.closest('th').setAttribute('aria-sort', key === 'name' ? 'ascending' : 'none');
  savedMapsSortDate.closest('th').setAttribute('aria-sort', key === 'date' ? 'descending' : 'none');
  renderSavedMapsTable();
}

savedMapsSortName.addEventListener('click', () => setSavedMapsSortKey('name'));
savedMapsSortDate.addEventListener('click', () => setSavedMapsSortKey('date'));

// § My Archives — Save Map dialog is shared by "Save Current Map" (create)
// and the Actions menu's "Edit name/notes" (update) -- editingSavedMapId
// distinguishes the two on submit. Since it's opened from within My
// Archives, that dialog closes first (native <dialog> supports stacked
// modals, but this app shows one at a time everywhere else) and reopens,
// refreshed, once this one is dismissed either way.
let editingSavedMapId = null;

async function reopenMyArchivesDialog() {
  await Promise.all([renderRecentMapsSection(), refreshSavedMapsSection()]);
  myArchivesDialog.showModal();
}

function openSaveMapDialog() {
  editingSavedMapId = null;
  saveMapNameInput.value = lastAnchorName || '';
  saveMapNotesInput.value = '';
  myArchivesDialog.close();
  saveMapDialog.showModal();
}

function openEditSavedMapDialog(record) {
  editingSavedMapId = record.id;
  saveMapNameInput.value = record.name || '';
  saveMapNotesInput.value = record.notes || '';
  myArchivesDialog.close();
  saveMapDialog.showModal();
}

btnSaveCurrentMap.addEventListener('click', () => {
  if (btnSaveCurrentMap.getAttribute('aria-disabled') === 'true') return;
  openSaveMapDialog();
});

saveMapForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = saveMapNameInput.value.trim();
  if (!name) return;
  const notes = saveMapNotesInput.value.trim();
  try {
    if (editingSavedMapId) {
      await updateSavedMapNameNotes(editingSavedMapId, name, notes);
    } else {
      await saveCurrentMapAs(name, notes);
    }
  } catch (err) {
    console.error('save map failed', err);
    setMessage('Save failed');
  }
  saveMapDialog.close();
  reopenMyArchivesDialog();
});

// § My Archives — a plain text <input> (Name) already submits its form on
// Enter natively; a <textarea> (Notes) does not, so this is needed only
// here. Shift+Enter still inserts a literal newline in Notes.
saveMapNotesInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && isExactModifiers(event, {})) {
    event.preventDefault();
    saveMapForm.requestSubmit();
  }
});

btnSaveMapCancel.addEventListener('click', () => {
  saveMapDialog.close();
  reopenMyArchivesDialog();
});

// § My Archives — Delete confirmation, same open-close-reopen dance as the
// Save Map dialog above.
let deletingSavedMapId = null;

function openDeleteSavedMapDialog(record) {
  deletingSavedMapId = record.id;
  deleteSavedMapMessage.textContent = `Are you sure you want to delete ${record.name} from your saved maps?`;
  myArchivesDialog.close();
  deleteSavedMapDialog.showModal();
}

btnDeleteSavedMapYes.addEventListener('click', async () => {
  const id = deletingSavedMapId;
  deletingSavedMapId = null;
  deleteSavedMapDialog.close();
  if (id) {
    try {
      await deleteSavedMap(id);
    } catch (err) {
      console.error('delete saved map failed', err);
      setMessage('Delete failed');
    }
  }
  reopenMyArchivesDialog();
});

btnDeleteSavedMapCancel.addEventListener('click', () => {
  deletingSavedMapId = null;
  deleteSavedMapDialog.close();
  reopenMyArchivesDialog();
});

// § My Archives — a single shared Actions popup menu, repositioned per row
// via getBoundingClientRect, rather than one menu widget per row (Saved
// Maps has no row limit). Open/close/keyboard-nav mirrors the Main Menu
// pattern above (openMainMenu/closeMainMenu/focusMainMenuItem).
let rowActionsTarget = null;
let rowActionsTriggerButton = null;

function rowActionsItems() {
  return [rowActionsEdit, rowActionsDelete];
}

function focusRowActionsItem(index) {
  const items = rowActionsItems();
  items.forEach((item, i) => item.setAttribute('tabindex', i === index ? '0' : '-1'));
  items[index].focus();
}

function openRowActionsMenu(triggerButton, record) {
  rowActionsTarget = record;
  rowActionsTriggerButton = triggerButton;
  triggerButton.setAttribute('aria-expanded', 'true');
  const rect = triggerButton.getBoundingClientRect();
  rowActionsMenu.style.top = `${rect.bottom}px`;
  rowActionsMenu.style.left = `${rect.left}px`;
  rowActionsMenu.hidden = false;
  focusRowActionsItem(0);
}

function closeRowActionsMenu({ focusTrigger = false } = {}) {
  if (rowActionsMenu.hidden) return;
  rowActionsMenu.hidden = true;
  if (rowActionsTriggerButton) {
    rowActionsTriggerButton.setAttribute('aria-expanded', 'false');
    if (focusTrigger) rowActionsTriggerButton.focus();
  }
  rowActionsTarget = null;
  rowActionsTriggerButton = null;
}

rowActionsItems().forEach((item) => {
  item.addEventListener('keydown', (event) => {
    const items = rowActionsItems();
    const index = items.indexOf(item);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRowActionsItem((index + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRowActionsItem((index - 1 + items.length) % items.length);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeRowActionsMenu({ focusTrigger: true });
    } else if (event.key === 'Tab') {
      closeRowActionsMenu();
    }
  });
});

rowActionsEdit.addEventListener('click', () => {
  const record = rowActionsTarget;
  closeRowActionsMenu();
  if (record) openEditSavedMapDialog(record);
});

rowActionsDelete.addEventListener('click', () => {
  const record = rowActionsTarget;
  closeRowActionsMenu();
  if (record) openDeleteSavedMapDialog(record);
});

document.addEventListener('click', (event) => {
  if (!rowActionsMenu.hidden && !event.target.closest('#row-actions-menu') && !event.target.closest('.row-actions-button')) {
    closeRowActionsMenu();
  }
});

// § Authentication — Google Sign-In via Firebase Authentication (see
// README § Authentication). Login/Logout follow the same shown-XOR-hidden
// convention as the existing Connect/Disconnect Dot Pad pair in this same
// menu, rather than one toggling label. My Archives itself is available
// signed out too (the current-map row in Recent Maps is local-only) --
// only the Firestore-backed history/saved sections require sign-in, see
// renderRecentMapsSection/refreshSavedMapsSection.
function updateAuthUI(user) {
  btnLogin.hidden = !!user;
  btnLogout.hidden = !user;
  if (user) {
    btnLogout.textContent = `Logged in as ${user.displayName || user.email} — logout`;
  }
}

// § Analytics — every visitor gets a silent, promptless anonymous Firebase
// session so overpassLogs (see logOverpassQuery) has a uid to attribute
// queries to without requiring sign-in. currentUser/updateAuthUI must
// stay blind to this: an anonymous session is deliberately filtered out
// here (isAnonymous check) so it never counts as "signed in" for Login/
// Logout or the Firestore-backed My Archives sections, which still mean
// a real Google account exactly as before. Only fires signInAnonymously
// when there's no session at all -- never overrides an existing real
// sign-in, and signing out (btnLogout below) naturally lands back here
// with user=null, which re-establishes a fresh anonymous session.
onAuthStateChanged(auth, (user) => {
  currentUser = user && !user.isAnonymous ? user : null;
  updateAuthUI(currentUser);
  if (!user) {
    signInAnonymously(auth).catch((err) => console.error('anonymous sign-in failed:', err));
  }
});

btnLogin.addEventListener('click', async () => {
  closeMainMenu({ focusButton: true });
  try {
    await signInWithPopup(auth, googleProvider);
    setMessage('Signed in');
  } catch (err) {
    console.error('Sign-in failed', err);
    setMessage('Sign-in failed: ' + (err.code || err.message || 'unknown error'));
  }
});

btnLogout.addEventListener('click', async () => {
  closeMainMenu({ focusButton: true });
  await signOut(auth);
  setMessage('Signed out');
});

// Centers the view exactly on (lat, lon) and moves the cursor there too --
// used for panning to a POI (newly added, or selected from the list), as
// opposed to panMap's fixed-amount directional step, which never moves the
// cursor. refreshMap's keepCursorInView shifts the view further if needed
// to keep the cursor visible, the same as it does after a scale change. No
// announcement of its own -- callers report whatever's appropriate (see
// panToPoint vs. panToSelectedPoi).
function moveViewportAndCursorTo(lat, lon) {
  viewportCenterLat = lat;
  viewportCenterLon = lon;
  cursorLat = lat;
  cursorLon = lon;
  refreshMap();
}

// § Pan Behavior / § Additional POIs — moveViewportAndCursorTo, plus the
// standard distance/direction-from-anchor announcement. Used for an
// explicit pan and for a newly added POI (see addAdditionalPoi) -- not for
// navigating among already-known POIs via the list box or ./,, which
// reports just the POI's own name instead (see panToSelectedPoi below).
function panToPoint(lat, lon) {
  moveViewportAndCursorTo(lat, lon);
  announcePositionRelativeToAnchor();
}

// § Pan Behavior — "[distance] [direction] of [anchor POI]," shared by an
// explicit pan and panning to a POI.
function announcePositionRelativeToAnchor() {
  const { eastFt, northFt } = feetOffsetFrom(viewportCenterLat, viewportCenterLon, lastAnchorLat, lastAnchorLon);
  const distFt = Math.hypot(eastFt, northFt);
  const compass = Math.abs(eastFt) > Math.abs(northFt)
    ? (eastFt >= 0 ? 'East' : 'West')
    : (northFt >= 0 ? 'North' : 'South');
  setMessage(distFt === 0 ? `At ${lastAnchorName}` : `${formatDistance(distFt)} ${compass} of ${lastAnchorName}`);
}

// § Data ingestion and cleaning pipeline — error reporting (see README.md §
// Data sources: "any Nominatim/Overpass error ... must be surfaced rather
// than fail silently"). geocode() and fetchWays() both throw an
// OsmFetchError classifying *why* the request failed; humanizeOsmError()
// turns that into the actual sentence shown via setMessage() at each call
// site, parametrized by which stage failed ('address' vs 'street-data').
class OsmFetchError extends Error {
  constructor(kind, status) {
    super(`osm-fetch-error:${kind}`);
    this.kind = kind; // 'network' | 'rate-limited' | 'timeout' | 'server-error' | 'malformed'
    this.status = status;
  }
}

// Maps an HTTP status from a non-ok response to an OsmFetchError kind.
// 'malformed' (added for the Postpass retry loop, see fetchFromPostpassWithRetry
// below) means the request itself was invalid -- confirmed 2026-07-31 by
// deliberately sending a bad query to Postpass: HTTP 400, plain-text
// PostgreSQL error body. Since our own query is always valid SQL we
// build ourselves, a 400 here would mean a bug in that code, not
// something real-world bbox/location variation could ever trigger --
// which is exactly why it's treated as non-retryable rather than
// bucketed with the genuinely transient kinds below.
function classifyHttpFailure(status) {
  if (status === 400) return 'malformed';
  if (status === 429) return 'rate-limited';
  if (status === 504) return 'timeout';
  return 'server-error';
}

const OSM_ERROR_MESSAGES = {
  address: {
    network: "Couldn't reach Google to look up that address — check your internet connection and try again.",
    'rate-limited': "Google's address lookup is rate-limiting requests right now. Wait a moment and try again.",
    timeout: 'The address lookup timed out. Try again in a moment.',
    'server-error': (status) => `Google's address lookup returned an unexpected error${status ? ` (status ${status})` : ''}. Try again in a moment.`
  },
  'street-data': {
    network: "Couldn't reach OpenStreetMap to fetch street data — check your internet connection and try again.",
    'rate-limited': "OpenStreetMap's street-data service is rate-limiting requests right now. Wait a moment and try again.",
    timeout: 'The street-data query took too long for this area. Try again, or try a smaller search area.',
    malformed: 'The street-data request itself was rejected as invalid. This points to a bug in the app rather than something retrying will fix — please file an issue.',
    'server-error': (status) => `OpenStreetMap's street-data service returned an unexpected error${status ? ` (status ${status})` : ''}. Try again in a moment.`
  }
};

// Logs the real error to the console (nothing did this before — the only
// trail was reproducing the request by hand) and returns the human-readable
// sentence for setMessage(). stage is 'address' or 'street-data'.
function humanizeOsmError(err, stage) {
  console.error(`${stage} fetch failed:`, err);
  const kind = err instanceof OsmFetchError ? err.kind : 'server-error';
  const status = err instanceof OsmFetchError ? err.status : undefined;
  const entry = OSM_ERROR_MESSAGES[stage][kind];
  return typeof entry === 'function' ? entry(status) : entry;
}

// Lazily loads the Maps JavaScript API bootstrap script (once per page
// load) and resolves once google.maps is available. Verified empirically
// (see project notes) that including libraries=places here makes
// google.maps.Geocoder constructable immediately on the load callback,
// without needing the newer importLibrary() pattern.
let googleMapsLoadPromise = null;
function loadGoogleMaps() {
  if (googleMapsLoadPromise) return googleMapsLoadPromise;
  googleMapsLoadPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps) {
      resolve();
      return;
    }
    window.__dottmapInitGoogleMaps = () => resolve();
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&callback=__dottmapInitGoogleMaps&loading=async`;
    script.async = true;
    script.onerror = () => reject(new Error('google-maps-script-failed'));
    document.head.appendChild(script);
  });
  return googleMapsLoadPromise;
}

// Maps a google.maps.GeocoderStatus (other than 'OK'/'ZERO_RESULTS', both
// handled by the caller) to the same OsmFetchError 'kind' vocabulary
// classifyHttpFailure uses for Overpass, so humanizeOsmError's wording and
// the call sites' catch blocks don't need to know which provider failed.
function classifyGoogleGeocoderStatus(status) {
  if (status === 'OVER_QUERY_LIMIT') return 'rate-limited';
  // Google's own docs describe UNKNOWN_ERROR as a transient server-side
  // issue where retrying is likely to succeed -- closest existing bucket.
  if (status === 'UNKNOWN_ERROR') return 'timeout';
  return 'server-error'; // REQUEST_DENIED, INVALID_REQUEST, etc.
}

// Converts a google.maps.GeocoderResult into the same shape geocode() has
// always returned (originally Nominatim's), so formatPlaceName/
// formatShortAddress and the local test-data cache (built from real
// Nominatim responses) don't need to change. One real behavior difference:
// place.name is always null here -- Geocoder resolves addresses, not
// business/POI names, unlike Nominatim's search endpoint.
function convertGoogleGeocodeResult(result) {
  const components = {};
  for (const component of result.address_components || []) {
    for (const type of component.types) {
      components[type] = component.long_name;
    }
  }
  return {
    lat: result.geometry.location.lat(),
    lon: result.geometry.location.lng(),
    display_name: result.formatted_address,
    name: null,
    address: {
      house_number: components.street_number,
      road: components.route,
      city: components.locality || components.postal_town || components.sublocality,
      state: components.administrative_area_level_1,
      postcode: components.postal_code,
      country: components.country
    }
  };
}

// § "Did you mean...?" — Google Places Text Search fallback, tried only
// when geocode() found nothing at all. Far more tolerant of typos/partial
// business names than the Geocoder, since it's a relevance-ranked search
// rather than deterministic address resolution. Returns [] on zero
// candidates *or* on any failure of the fallback search itself -- either
// way the caller just falls back to the ordinary "No results" message,
// same as if this fallback didn't exist; a failure here isn't worth its
// own error message on top of the address lookup that already failed.
async function searchPlacesTextFallback(query) {
  try {
    await loadGoogleMaps();
    const { places } = await google.maps.places.Place.searchByText({
      textQuery: query,
      fields: ['displayName', 'formattedAddress', 'location', 'addressComponents'],
      maxResultCount: 10
    });
    return (places || []).map(convertPlacesResult);
  } catch (err) {
    console.error('places text-search fallback failed:', err);
    return [];
  }
}

// Same target shape as convertGoogleGeocodeResult (see above), but reading
// the Places (New) SDK's AddressComponent accessors -- .longText/.types,
// not Geocoder's .long_name -- a different shape from the same-looking
// "address_components" data, because this is a different Places API
// service (places.googleapis.com) from the Geocoding API.
function convertPlacesResult(place) {
  const components = {};
  for (const component of place.addressComponents || []) {
    for (const type of component.types) {
      components[type] = component.longText;
    }
  }
  return {
    lat: place.location.lat(),
    lon: place.location.lng(),
    display_name: place.formattedAddress,
    name: place.displayName || null,
    address: {
      house_number: components.street_number,
      road: components.route,
      city: components.locality || components.postal_town || components.sublocality,
      state: components.administrative_area_level_1,
      postcode: components.postal_code,
      country: components.country
    }
  };
}

// § Data ingestion and cleaning pipeline, step 1 (Geocode)
async function geocode(query) {
  const cached = await loadLocalTestData(query);
  if (cached) return cached.geocode;

  try {
    await loadGoogleMaps();
  } catch (err) {
    throw new OsmFetchError('network');
  }

  const geocoder = new google.maps.Geocoder();
  let response;
  try {
    response = await geocoder.geocode({ address: query });
  } catch (err) {
    const status = err && err.code;
    if (status === 'ZERO_RESULTS') return null;
    throw new OsmFetchError(classifyGoogleGeocoderStatus(status), status);
  }

  return response.results.length ? convertGoogleGeocodeResult(response.results[0]) : null;
}

function formatPlaceName(place) {
  const address = place.address || {};
  const parts = [];
  if (place.name) parts.push(place.name);
  const streetLine = [address.house_number, address.road].filter(Boolean).join(' ');
  if (streetLine) parts.push(streetLine);
  const city = address.city || address.town || address.village;
  if (city) parts.push(city);
  if (address.state) parts.push(address.state);
  if (address.postcode) parts.push(address.postcode);
  return parts.length ? parts.join(', ') : place.display_name;
}

// § POIs — the short form used whenever a POI is spoken, brailled, or
// otherwise referenced (message field, POI list entries, the too-far
// dialog): street address only, no business/POI name, city, state, or zip.
// formatPlaceName's fuller result is reserved for the on-screen title and
// H2 heading only. Falls back to the full name for the rare place with no
// house_number/road at all (e.g. a searched city or neighborhood).
function formatShortAddress(place) {
  const address = place.address || {};
  const streetLine = [address.house_number, address.road].filter(Boolean).join(' ');
  return streetLine || formatPlaceName(place);
}

// § Data sources — square region centered on the anchor POI, half-side = POI
// distance threshold setting.
function squareBoundingBox(lat, lon, halfSideMiles) {
  const halfSideMeters = halfSideMiles * MILES_TO_METERS;
  const metersPerDegreeLat = 111320;
  const latDelta = halfSideMeters / metersPerDegreeLat;
  const lonDelta = halfSideMeters / (metersPerDegreeLat * Math.cos((lat * Math.PI) / 180));
  return {
    south: lat - latDelta,
    north: lat + latDelta,
    west: lon - lonDelta,
    east: lon + lonDelta
  };
}

const FEET_TO_METERS = 0.3048;
const METERS_PER_DEGREE_LAT = 111320;
const FEET_PER_MILE = MILES_TO_METERS / FEET_TO_METERS;

function feetToLatDelta(feet) {
  return (feet * FEET_TO_METERS) / METERS_PER_DEGREE_LAT;
}

function feetToLonDelta(feet, atLat) {
  return (feet * FEET_TO_METERS) / (METERS_PER_DEGREE_LAT * Math.cos((atLat * Math.PI) / 180));
}

// East/north offset in feet of (lat, lon) from (fromLat, fromLon).
function feetOffsetFrom(lat, lon, fromLat, fromLon) {
  const northFt = ((lat - fromLat) * METERS_PER_DEGREE_LAT) / FEET_TO_METERS;
  const eastFt = ((lon - fromLon) * METERS_PER_DEGREE_LAT * Math.cos((fromLat * Math.PI) / 180)) / FEET_TO_METERS;
  return { eastFt, northFt };
}

// § Scale behavior / § Braille labels — current viewport width/height in
// feet, from the selected preset, applied per-axis via the Dot Pad's
// measured (isotropic, ~10 DPI) dot pitch rather than a fixed 3x2 ratio --
// necessary now that active label zones can make the map's sub-region
// narrower and/or shorter than the full physical display, including
// asymmetric cases (e.g. only a top zone) that no longer keep a 3x2 shape.
function viewportSizeFeet() {
  const b = mapGridBounds();
  const inchesPerDot = DOT_PAD_DISPLAY_WIDTH_INCHES / DOT_GRID_WIDTH;
  if (unitSystem === 'metric') {
    const cmPerDot = inchesPerDot * CM_PER_INCH;
    const widthM = SCALE_PRESETS_M[scaleIndex] * (b.width * cmPerDot);
    const heightM = SCALE_PRESETS_M[scaleIndex] * (b.height * cmPerDot);
    return { widthFt: widthM / FEET_TO_METERS, heightFt: heightM / FEET_TO_METERS };
  }
  const widthFt = SCALE_PRESETS_FT[scaleIndex] * (b.width * inchesPerDot);
  const heightFt = SCALE_PRESETS_FT[scaleIndex] * (b.height * inchesPerDot);
  return { widthFt, heightFt };
}

// The geo bbox for an arbitrary candidate center, sized by the current
// scale and clamped to never exceed the fetched data (lastBbox) even if
// the viewport is larger. Factored out of getViewportBbox so Pan
// Behavior's clipping-avoidance nudge (see panMap) can preview the bbox a
// candidate pan target would produce before committing to it.
function viewportBboxForCenter(centerLat, centerLon) {
  const { widthFt, heightFt } = viewportSizeFeet();
  const latDelta = feetToLatDelta(heightFt / 2);
  const lonDelta = feetToLonDelta(widthFt / 2, centerLat);
  return {
    south: Math.max(lastBbox.south, centerLat - latDelta),
    north: Math.min(lastBbox.north, centerLat + latDelta),
    west: Math.max(lastBbox.west, centerLon - lonDelta),
    east: Math.min(lastBbox.east, centerLon + lonDelta)
  };
}

// The geo bbox actually projected/displayed right now: centered on
// viewportCenterLat/Lon.
function getViewportBbox() {
  if (viewportCenterLat === null || !lastBbox) return null;
  return viewportBboxForCenter(viewportCenterLat, viewportCenterLon);
}

// § Scale behavior / § Settings — Traditional Scale ("X = Y") is the only
// scale format this app offers (see tmap spec.md's retired Display Area
// appendix) -- this is just the label; the real-world viewport math itself
// lives in viewportSizeFeet().
function formatScaleLabel(index) {
  return unitSystem === 'metric'
    ? `1 cm = ${SCALE_PRESETS_M[index]} m`
    : `1 in = ${SCALE_PRESETS_FT[index]} ft`;
}

// § Settings — re-labels every existing Scale combo box option after a
// Units change (see settingsUnitsSelect's change listener below). Only the
// text changes; option values stay the same index, so the current
// selection (scaleIndex) survives the switch untouched.
function refreshScaleOptions() {
  Array.from(scaleSelect.options).forEach((option, index) => {
    option.textContent = formatScaleLabel(index);
  });
}

// § Pan Behavior / § Additional POIs / § Settings — formats a distance (in
// feet, this file's one internal distance unit -- see feetOffsetFrom) for
// on-screen/braille display under the current unitSystem. Per an explicit
// user decision: Imperial reports feet up to 1000 ft, then miles (rounded
// to the nearest tenth) beyond; Metric reports meters up to 500 m, then
// kilometers (rounded to the nearest tenth) beyond. Shared by
// announcePositionRelativeToAnchor (panning/POI navigation) and
// promptTooFarPoi (the too-far-for-one-map dialog).
function formatDistance(distFt) {
  if (unitSystem === 'metric') {
    const meters = distFt * FEET_TO_METERS;
    return meters <= 500 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
  }
  return distFt <= 1000 ? `${Math.round(distFt)} ft` : `${(distFt / FEET_PER_MILE).toFixed(1)} mi`;
}

// § Analytics — one row per live Overpass query (never for local
// test-data cache hits, see fetchWays' early-return below -- no real
// network call happened, so there's nothing to measure), so query volume,
// per-user counts, and reliability can be estimated over time without
// requiring sign-in (see uid below). Never blocks or fails the caller: a
// logging failure is swallowed here, same "never fail the user over a
// side channel" principle as the rest of the app applies to its actual
// features. country/errorType are whatever the caller has on hand -- null
// is a valid, expected value for both (see call sites), not a bug.
// dataSource/attempt/requestId (spec §4.6) default to plain Overpass
// values so fetchWays()'s existing single-attempt Overpass call sites
// don't need editing to get a consistent schema -- only
// fetchFromPostpassWithRetry below passes them explicitly.
function logOverpassQuery({ elapsedMs, errorType, country, dataSource = 'overpass', attempt = 1, requestId = null }) {
  addDoc(collection(db, 'overpassLogs'), {
    uid: auth.currentUser ? auth.currentUser.uid : null,
    timestamp: serverTimestamp(),
    elapsedMs,
    errorType,
    country: country || null,
    buildId: BUILD_ID,
    dataSource,
    attempt,
    requestId
  }).catch((err) => console.error('overpass log write failed:', err));
}

// § Data ingestion and cleaning pipeline, step 2 (Fetch). searchQuery is the
// original user-typed search text (not the Overpass QL below) -- passed
// through purely so this can be matched against the local test data cache,
// same key geocode() uses for the same search. country is purely for
// logOverpassQuery's analytics row below -- see call sites for where it
// does/doesn't have a real value.
//
// DATA_SOURCE branch (spec §4.5): Postpass gets its own retry-wrapped
// path; Overpass's existing single-attempt code below is completely
// unchanged either way. Both callers of fetchWays() (createNewAnchor,
// loadMapRecord) are unaware this branch exists -- they just get ways
// back or an OsmFetchError, same contract as before.
async function fetchWays(bbox, searchQuery, country) {
  const cached = await loadLocalTestData(searchQuery);
  if (cached) return cached.ways;

  if (DATA_SOURCE === 'postpass') {
    return fetchFromPostpassWithRetry(bbox, crypto.randomUUID(), country);
  }

  const overpassQuery = `[out:json][timeout:25];way["highway"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out geom;`;
  const fetchStart = Date.now();
  let res;
  try {
    res = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(overpassQuery)
    });
  } catch (err) {
    logOverpassQuery({ elapsedMs: Date.now() - fetchStart, errorType: 'network', country });
    throw new OsmFetchError('network');
  }
  if (!res.ok) {
    const kind = classifyHttpFailure(res.status);
    logOverpassQuery({ elapsedMs: Date.now() - fetchStart, errorType: kind, country });
    throw new OsmFetchError(kind, res.status);
  }
  const data = await res.json();
  // Overpass can return HTTP 200 with an empty/partial result and a
  // `remark` field describing a server-side failure (e.g. a query timeout)
  // -- this wouldn't trip res.ok at all, and used to render as a silent
  // "no streets here" instead of surfacing the real cause.
  if (data.remark) {
    logOverpassQuery({ elapsedMs: Date.now() - fetchStart, errorType: 'timeout', country });
    throw new OsmFetchError('timeout');
  }
  logOverpassQuery({ elapsedMs: Date.now() - fetchStart, errorType: null, country });
  return data.elements || [];
}

// § Postpass migration (see postpass-migration-spec.md) — Phase 1: pure,
// standalone functions only. Nothing below is called from fetchWays()
// yet -- that's Phase 2 -- so each piece (query, adapter, retry loop)
// can be verified in isolation first.

function buildPostpassQuery(bbox) {
  return `SELECT osm_id, geom, tags FROM postpass_line WHERE geom && ST_MakeEnvelope(${bbox.west},${bbox.south},${bbox.east},${bbox.north},4326) AND tags?'highway' AND tags?'name'`;
}

// Resolved 2026-07-31 (spec §4.2): sampled 2,601 ways across 7 diverse
// areas, including a major highway interchange and a roundabout-heavy
// city -- zero multi-part geometries. MultiLineString appears to just be
// Postpass's general packaging convention for line geometries, not a
// signal that a way is actually split into disconnected parts. Takes the
// first (and, so far, only) part; warns rather than silently mishandling
// it if that assumption is ever wrong in practice.
function flattenMultiLineString(geometry) {
  if (geometry.coordinates.length > 1) {
    console.warn('Postpass returned a multi-part MultiLineString -- unexpected, see postpass-migration-spec.md §4.2', geometry);
  }
  return geometry.coordinates[0].map(([lon, lat]) => ({ lat, lon }));
}

// Converts a Postpass FeatureCollection into the exact shape fetchWays()
// already returns for Overpass, so processWays() and everything
// downstream needs zero changes.
function adaptPostpassResponse(geoJson) {
  return geoJson.features.map((f) => ({
    type: 'way',
    id: f.properties.osm_id,
    tags: f.properties.tags || {},
    geometry: flattenMultiLineString(f.geometry)
  }));
}

// Mirrors Overpass's `remark`-field soft-failure check above -- a 200 OK
// whose body isn't actually a real FeatureCollection.
function checkPostpassSoftFailure(data) {
  if (data.type !== 'FeatureCollection') return 'unexpected response shape';
  return null;
}

const POSTPASS_URL = 'https://postpass.geofabrik.de/api/interpreter';
const POSTPASS_TOTAL_TIMEOUT_MS = 25000;
const POSTPASS_ATTEMPT_TIMEOUT_MS = 8000;
const POSTPASS_BACKOFF_MS = [250, 750, 1500];
const POSTPASS_RETRYABLE_KINDS = new Set(['network', 'timeout', 'rate-limited', 'server-error']);

// One attempt. Throws OsmFetchError either way (never a raw fetch/abort
// error) so the retry loop below only ever has one error shape to
// reason about.
async function fetchPostpassOnce(query, timeoutMs) {
  let res;
  try {
    res = await fetch(POSTPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new OsmFetchError(err.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (!res.ok) {
    throw new OsmFetchError(classifyHttpFailure(res.status), res.status);
  }
  const data = await res.json();
  const softFailure = checkPostpassSoftFailure(data);
  if (softFailure) throw new OsmFetchError('server-error', res.status);
  return adaptPostpassResponse(data);
}

// The proposed retry model (spec §4.4): a 25s total budget across all
// attempts, an 8s per-attempt cap so one hung attempt can't consume the
// whole budget and leave no room for a retry, and 250/750/1500ms backoff
// -- only for the transient-looking kinds. A 'malformed' failure (a bug
// in buildPostpassQuery itself, not real-world bbox variation -- see
// classifyHttpFailure) stops immediately instead of burning the budget
// on a guaranteed repeat failure. Every attempt is logged, win or lose.
async function fetchFromPostpassWithRetry(bbox, requestId, country) {
  const query = buildPostpassQuery(bbox);
  const searchStart = Date.now();
  let attempt = 0;
  let lastError;

  while (Date.now() - searchStart < POSTPASS_TOTAL_TIMEOUT_MS) {
    attempt += 1;
    const remainingMs = POSTPASS_TOTAL_TIMEOUT_MS - (Date.now() - searchStart);
    const attemptTimeout = Math.max(1, Math.min(POSTPASS_ATTEMPT_TIMEOUT_MS, remainingMs));
    const attemptStart = Date.now();
    try {
      const ways = await fetchPostpassOnce(query, attemptTimeout);
      logOverpassQuery({ elapsedMs: Date.now() - attemptStart, errorType: null, country, dataSource: 'postpass', attempt, requestId });
      return ways;
    } catch (err) {
      lastError = err;
      logOverpassQuery({ elapsedMs: Date.now() - attemptStart, errorType: err.kind, country, dataSource: 'postpass', attempt, requestId });
      if (!POSTPASS_RETRYABLE_KINDS.has(err.kind)) throw err;
      const backoff = POSTPASS_BACKOFF_MS[Math.min(attempt - 1, POSTPASS_BACKOFF_MS.length - 1)];
      if (POSTPASS_TOTAL_TIMEOUT_MS - (Date.now() - searchStart) - backoff <= 0) throw err;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastError;
}

// § Data ingestion and cleaning pipeline — the automated roadway/pedestrian
// dedup and carriageway collapse that used to run here are still removed
// for the manual-editing experiment (see git tag `pre-manual-declutter` on
// main for that code, and the project's own notes on why; a later,
// name-match-based "Redundant sidewalks" filter was also tried and retired
// -- see git history around commit `7324c55` if it's ever wanted back).
// Tier assignment came back, though: every way still gets tagged with its
// street-importance tier, purely as data for the Map Complexity filter (see
// MAP_COMPLEXITY_LEVELS/visibleWays) -- nothing here hides anything
// automatically.
function processWays(rawWays) {
  for (const way of rawWays) {
    way.tier = HIGHWAY_TIERS[way.tags && way.tags.highway] || MAX_TIER;
  }
  return rawWays;
}

// Projects into the map's sub-rectangle of the SVG canvas (see svgMapRect),
// not the full 600x400 canvas -- active label zones shrink and offset it.
function projectToSvg(lat, lon, bbox) {
  const rect = svgMapRect();
  const x = rect.x + ((lon - bbox.west) / (bbox.east - bbox.west)) * rect.width;
  const y = rect.y + ((bbox.north - lat) / (bbox.north - bbox.south)) * rect.height;
  return { x, y };
}

// Same proportions as projectToSvg, but in grid dots relative to the map's
// own drawable sub-rectangle (0..mapGridBounds().width/height) rather than
// absolute SVG units -- and with no -0.5 pixel-center shift, since this
// feeds Pan Behavior's clipping-avoidance nudge (see panMap), which needs
// the same continuous position projectToSvg would actually render at, not
// projectToGrid's cursor/hit-testing-oriented quantization.
function mapRelativeDotPosition(lat, lon, bbox) {
  const b = mapGridBounds();
  const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * b.width;
  const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * b.height;
  return { x, y };
}

// Same -0.5 pixel-center convention as rasterizeMapToPixels, so cursor/hit
// testing lines up with what the tactile display actually shows. Grid
// space here is map-relative (0..mapGridBounds().width/height), not the
// full DOT_GRID_WIDTH/HEIGHT canvas -- see mapGridBounds.
function projectToGrid(lat, lon, bbox) {
  const b = mapGridBounds();
  const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * b.width - 0.5;
  const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * b.height - 0.5;
  return { x, y };
}

// Inverse of projectToGrid: map-relative grid position -> lat/lon, for the
// same bbox.
function gridToLatLon(gridX, gridY, bbox) {
  const b = mapGridBounds();
  const lon = bbox.west + ((gridX + 0.5) / b.width) * (bbox.east - bbox.west);
  const lat = bbox.north - ((gridY + 0.5) / b.height) * (bbox.north - bbox.south);
  return { lat, lon };
}

// The cursor's position in the *current* viewport's grid space, clamped to
// what's actually on screen. Returns null if there's no map or viewport yet.
function cursorGridPosition(viewportBbox) {
  if (cursorLat === null || !viewportBbox) return null;
  const b = mapGridBounds();
  const p = projectToGrid(cursorLat, cursorLon, viewportBbox);
  return {
    x: clamp(Math.round(p.x), 0, b.width - 1),
    y: clamp(Math.round(p.y), 0, b.height - 1)
  };
}

// displayName (fuller: may include a business/POI name, city, state, zip)
// is used only for the on-screen title and heading. shortName (street
// address only, see formatShortAddress) is what's spoken/brailled
// everywhere else, including this initial "found it" announcement.
function showAnchor(displayName, shortName, lat, lon, bbox, ways) {
  document.title = `DotTMAP — ${displayName}`;
  anchorHeading.textContent = displayName;
  anchorHeading.hidden = false;

  // § New Map / New Pin — a one-time, one-way UI switch, same as hasAnchor
  // itself: once a map exists, the standalone New Map button (the only
  // entry point before this point) is replaced by the New menu (New Map +
  // New Pin), and the "get started" instructions disappear to make more
  // room for the map.
  if (!hasAnchor) {
    hasAnchor = true;
    startInstructions.hidden = true;
    btnNewMapStandalone.hidden = true;
    newMenuContainer.hidden = false;
  }

  lastBbox = bbox;
  lastRawWays = ways;
  lastWays = processWays(lastRawWays);
  saveCurrentMapWaysLocally(lastRawWays);
  lastAnchorLat = lat;
  lastAnchorLon = lon;
  // § Feature name compacting — compacted once here at creation time
  // (e.g. "1400 Hearst Avenue" -> "1400 Hearst Ave"), not left for each
  // display site to compact on the fly -- everywhere this name is later
  // shown or spoken (POI list, Edit Map dialog, nav announcements) just
  // reads it directly.
  const compactedName = compactedDisplayName(shortName);
  lastAnchorName = compactedName;

  // § Editing the Map — a brand-new anchor is a brand-new feature set;
  // whatever was hidden on the discarded map doesn't carry over.
  hiddenPoiNames = new Set();
  hiddenStreetNames = new Set();
  mapComplexityIndex = 0;
  cursorOnlyMode = false;
  // A pending timeout from the discarded map must not fire later and touch
  // whatever cursor-only state the new map ends up in.
  clearCursorSoloTimer();

  // § Scale behavior / § Pan Behavior — reset the viewport to the anchor
  // POI at the default scale on every new search.
  viewportCenterLat = lat;
  viewportCenterLon = lon;
  scaleIndex = DEFAULT_SCALE_INDEX;
  scaleSelect.value = String(scaleIndex);

  // § Cursor and hit testing — cursor starts at the anchor POI on a new
  // search (but not on later pan/scale changes -- see refreshMap).
  cursorLat = lat;
  cursorLon = lon;
  cursorSvg.hidden = false;
  scaleSelect.disabled = false;
  btnEditMap.removeAttribute('aria-disabled');
  btnDownloadSvg.removeAttribute('aria-disabled');
  // § Auto Simplification — resolved at the default scale before the one
  // refreshMap() call below, so even the very first view of a dense area
  // is already appropriately simplified, with no flash of the wrong level.
  const simplifyLabel = maybeAutoAdjustComplexity();
  refreshMap();

  setMessage(simplifyLabel ? `${compactedName} ${simplifyLabel} visible.` : compactedName);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Central re-render: recomputes the viewport bbox, redraws the on-screen
// map, repositions the cursor, and refreshes the tactile display if
// connected. Called after a new search, a pan, or a scale change.

// § Pan Behavior — "unless rescaling forces a pan due to edge-of-map": if
// the cursor's fixed real-world position would fall outside the viewport
// after whatever just changed it (scale, or a pan that happens to leave an
// already-near-edge cursor out of view), shift the viewport center just
// enough to bring it back on screen, the same way an explicit pan would.
// Falls back to leaving it clamped to the display edge (see
// cursorGridPosition) only if the fetched data itself doesn't allow enough
// room to shift into -- the one case where map-fixed and display-fixed
// genuinely can't both hold, and map-fixed wins.
const VIEW_MARGIN_UNITS = 2;
function keepCursorInView() {
  if (cursorLat === null || !lastBbox) return;
  const viewportBbox = getViewportBbox();
  if (!viewportBbox) return;
  const b = mapGridBounds();
  const p = projectToGrid(cursorLat, cursorLon, viewportBbox);

  let overflowX = 0;
  if (p.x < 0) overflowX = p.x - VIEW_MARGIN_UNITS;
  else if (p.x > b.width - 1) overflowX = p.x - (b.width - 1) + VIEW_MARGIN_UNITS;

  let overflowY = 0;
  if (p.y < 0) overflowY = p.y - VIEW_MARGIN_UNITS;
  else if (p.y > b.height - 1) overflowY = p.y - (b.height - 1) + VIEW_MARGIN_UNITS;

  if (overflowX === 0 && overflowY === 0) return;

  const { widthFt, heightFt } = viewportSizeFeet();
  const ftPerUnitX = widthFt / b.width;
  const ftPerUnitY = heightFt / b.height;

  let newLat = viewportCenterLat - feetToLatDelta(overflowY * ftPerUnitY);
  let newLon = viewportCenterLon + feetToLonDelta(overflowX * ftPerUnitX, viewportCenterLat);

  // Clamp the shift to what the fetched data allows, degrading to centering
  // within it if the viewport itself is larger than the fetched region.
  const halfLat = feetToLatDelta(heightFt / 2);
  const minCenterLat = lastBbox.south + halfLat;
  const maxCenterLat = lastBbox.north - halfLat;
  newLat = minCenterLat <= maxCenterLat
    ? clamp(newLat, minCenterLat, maxCenterLat)
    : (lastBbox.south + lastBbox.north) / 2;

  const halfLon = feetToLonDelta(widthFt / 2, newLat);
  const minCenterLon = lastBbox.west + halfLon;
  const maxCenterLon = lastBbox.east - halfLon;
  newLon = minCenterLon <= maxCenterLon
    ? clamp(newLon, minCenterLon, maxCenterLon)
    : (lastBbox.west + lastBbox.east) / 2;

  viewportCenterLat = newLat;
  viewportCenterLon = newLon;
}

function refreshMap() {
  keepCursorInView();
  const viewportBbox = getViewportBbox();

  // § Braille labels — zones redraw even with no map loaded yet (toggling
  // before a search is allowed), so renderScene runs unconditionally;
  // street/anchor/cursor positioning still needs a real viewport.
  renderScene(viewportBbox);
  if (!viewportBbox) return;

  // Cursor keeps its real-world position (cursorLat/cursorLon) through pan
  // and scale changes -- just reproject it against the new viewport, rather
  // than resetting it. See the cursorLat/cursorLon declaration for why.
  updateCursorVisual();

  if (currentDevice) {
    sendGraphicToDevice(currentDevice);
  }
}

// Clears and redraws the whole on-screen SVG: label zones first (always),
// then streets/anchor within the map sub-rect (only once a map is loaded),
// then the cursor on top.
function renderScene(viewportBbox) {
  mapSvg.innerHTML = '';
  const svgNs = 'http://www.w3.org/2000/svg';

  drawLabelZoneRects(svgNs);

  if (viewportBbox) {
    renderStreetsAndAnchor(svgNs, viewportBbox, visibleWays(), lastAnchorLat, lastAnchorLon);
    drawLabelContent(svgNs, computeLabelPlacements(), mapGridBounds());
    // Pan edge bars, same "only once there's a real map" gating as the
    // cursor below -- pre-search there's no meaningful sub-rect to size
    // them against.
    positionPanEdgeBars();
    panEdgeBars.forEach((bar) => mapSvg.appendChild(bar));
    // Cursor is a single reused element, drawn last (on top). Only appended
    // once there's a real viewport/position -- cursorSvg.hidden doesn't
    // reliably suppress rendering for an SVG element, so keeping it out of
    // the DOM entirely pre-search (as before this function existed) avoids
    // showing a stray circle at its default (0,0) position.
    mapSvg.appendChild(cursorSvg);
  }
}

// § Feature name compacting — general-purpose, not braille-specific (also
// the intended source for the planned SVG export's compacted-name
// metadata). OSM's `name` tag is consistently fully-expanded; neither
// `alt_name` (can hold a genuinely different name, not just a shorter
// form of the same one) nor `tiger:name_type` (only ~60% present in this
// project's own cached data, and measurably inconsistent where it does
// exist -- see tmap spec.md's Feature name compacting section) are
// reliable enough to depend on, so both lookups here are hand-built
// rather than sourced from an OSM tag. A starting/extensible set, not
// claimed to be exhaustive.
const STREET_TYPE_ABBREVIATIONS = {
  alley: 'Aly',
  avenue: 'Ave',
  boulevard: 'Blvd',
  circle: 'Cir',
  court: 'Ct',
  crescent: 'Cres',
  drive: 'Dr',
  expressway: 'Expy',
  freeway: 'Fwy',
  highway: 'Hwy',
  lane: 'Ln',
  loop: 'Loop',
  parkway: 'Pkwy',
  path: 'Path',
  place: 'Pl',
  plaza: 'Plz',
  road: 'Rd',
  row: 'Row',
  square: 'Sq',
  street: 'St.',
  terrace: 'Ter',
  trail: 'Trl',
  walk: 'Walk',
  way: 'Way'
};

// § Feature name compacting — ordinal number words to digit+suffix form.
// Three tables cover every ordinal a street name is realistically going
// to contain: ones (First-Ninth), teens (Tenth-Nineteenth), and bare tens
// (Twentieth, Thirtieth, ... Ninetieth) as single-word matches, plus
// CARDINAL_TENS (Twenty, Thirty, ... Ninety) for detecting a tens+ones
// compound like "Twenty-First" in convertOrdinalWords below. Anything
// past the 90s (or any non-ordinal word) simply isn't in these tables and
// passes through untouched -- no special-casing needed for that.
const ORDINAL_ONES = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
  sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th'
};
const ORDINAL_TEENS = {
  tenth: '10th', eleventh: '11th', twelfth: '12th', thirteenth: '13th',
  fourteenth: '14th', fifteenth: '15th', sixteenth: '16th', seventeenth: '17th',
  eighteenth: '18th', nineteenth: '19th'
};
const ORDINAL_TENS = {
  twentieth: '20th', thirtieth: '30th', fortieth: '40th', fiftieth: '50th',
  sixtieth: '60th', seventieth: '70th', eightieth: '80th', ninetieth: '90th'
};
const CARDINAL_TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};

function ordinalWordToDigits(word) {
  const lower = word.toLowerCase();
  return ORDINAL_ONES[lower] || ORDINAL_TEENS[lower] || ORDINAL_TENS[lower] || null;
}

// § Feature name compacting — replaces the first ordinal number word (or
// tens+ones compound, e.g. "Twenty-First", hyphenated or not) found in a
// name with its digit+suffix form; everything else is returned untouched.
// Stops at the first match -- a street name only ever has one ordinal in
// practice (the street's own number), never several to find.
function convertOrdinalWords(name) {
  const tokens = name.split(/(\s+|-)/);
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    if (!/^[A-Za-z]+$/.test(word)) continue;

    const tensValue = CARDINAL_TENS[word.toLowerCase()];
    if (tensValue !== undefined && i + 2 < tokens.length && /^(\s+|-)$/.test(tokens[i + 1])) {
      const onesDigits = ordinalWordToDigits(tokens[i + 2]);
      if (onesDigits) {
        const suffix = onesDigits.replace(/^\d+/, '');
        const combined = String(tensValue + parseInt(onesDigits, 10)) + suffix;
        tokens.splice(i, 3, combined);
        return tokens.join('');
      }
    }

    const digits = ordinalWordToDigits(word);
    if (digits) {
      tokens[i] = digits;
      return tokens.join('');
    }
  }
  return name;
}

// § Feature name compacting — splits a name into { stem, type }: if the
// name's trailing word is a recognized street-type word, type becomes its
// standard abbreviation and stem is the name with that word removed;
// otherwise type is empty and stem is the full name, unchanged.
function splitStreetType(name) {
  const words = name.trim().split(/\s+/);
  const lastWordClean = words[words.length - 1].replace(/[^A-Za-z]/g, '').toLowerCase();
  const abbreviation = STREET_TYPE_ABBREVIATIONS[lastWordClean];
  if (!abbreviation) return { stem: name, type: '' };
  return { stem: words.slice(0, -1).join(' '), type: abbreviation };
}

// § Feature name compacting — top-level entry point: splits off a
// recognized street-type suffix, then converts any ordinal number word
// within what's left. Both steps degrade gracefully (see above), so a
// name with neither passes through with stem = the full name, type = ''.
function compactFeatureName(name) {
  const { stem, type } = splitStreetType(name);
  return { stem: convertOrdinalWords(stem), type };
}

// § Feature name compacting — stem and type space-joined into the single
// display string used everywhere a compacted name is actually shown or
// spoken (cursor hit-test messages, POI names -- see addAdditionalPoi/
// showAnchor). Degrades gracefully the same way compactFeatureName
// itself does: a name with no recognized type passes through unchanged.
function compactedDisplayName(name) {
  const { stem, type } = compactFeatureName(name);
  return type ? `${stem} ${type}` : stem;
}

// § Braille labels / § Label creation — ported from the OSM Data Mine
// experiment site's "Braille Labels" tab (experiment/app.js) once that
// tab validated the algorithm against real Overpass data. See tmap
// spec.md's Label creation section for the numbered steps this
// implements. Operates on every name currently in lastWays (not
// visibleWays()) -- per spec, "No two streets on the map, even if
// they're not both being displayed currently, may have the same
// abbreviation."
const LABEL_VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'A', 'E', 'I', 'O', 'U']);

// § Label creation — a stem's leading compass-direction word, fully
// spelled out, is replaced with its short form before the stem is joined
// to the type. Only the ones map to a value containing a vowel (e/o) --
// "ne" and "se" -- so those two are the ones that need protecting from
// the vowel-stripping step below; the rest (n, e, s, w, sw, nw) already
// survive it untouched since they either have no vowel or are the
// single-vowel-letter case that step already exempts.
const DIRECTION_ABBREVIATIONS = {
  north: 'n', northeast: 'ne', east: 'e', southeast: 'se',
  south: 's', southwest: 'sw', west: 'w', northwest: 'nw'
};
const DIRECTION_ABBREVIATION_TOKENS = new Set(Object.values(DIRECTION_ABBREVIATIONS));

// § Label creation — checks only the stem's first word (a street's own
// descriptive name never legitimately contains a second, independent
// direction word) against DIRECTION_ABBREVIATIONS; no match leaves the
// stem untouched.
function abbreviateLeadingDirection(stem) {
  const words = stem.split(/\s+/);
  const firstClean = words[0].replace(/[^A-Za-z]/g, '').toLowerCase();
  const abbreviation = DIRECTION_ABBREVIATIONS[firstClean];
  if (!abbreviation) return stem;
  words[0] = abbreviation;
  return words.join(' ');
}

// § Label creation, step 1 — strip vowels from each word of the name,
// except when a word (once its own punctuation is stripped) is a single
// vowel letter on its own, e.g. "A Street" or "E. 12th St.", or is one of
// the direction-abbreviation tokens above ("ne"/"se") -- those words are
// kept whole. Runs on the original whitespace-separated words, since word
// boundaries still need to exist for this check; spaces themselves aren't
// removed until the next step.
function stripVowelsPreservingSingleLetterWords(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lettersOnly = word.replace(/[^A-Za-z]/g, '');
      if (lettersOnly.length === 1 && LABEL_VOWELS.has(lettersOnly)) return word;
      if (DIRECTION_ABBREVIATION_TOKENS.has(lettersOnly.toLowerCase())) return word;
      return [...word].filter((ch) => !LABEL_VOWELS.has(ch)).join('');
    })
    .join(' ');
}

// § Label creation — collapses every run of 2+ identical consecutive
// letters (case-insensitively) down to one occurrence, anywhere in the
// string, including across what used to be the stem/type word boundary
// now that they're concatenated rather than space-joined (e.g. "...t" +
// "T..." collapses to one "t"). Digits are exempt -- a repeated digit
// (the "11" in "11th") is real information, not a doubled-letter
// artifact, so runs of the same digit are always left alone.
function compressRepeatedLetters(s) {
  let result = '';
  for (const ch of s) {
    const prev = result[result.length - 1];
    const isDigit = ch >= '0' && ch <= '9';
    if (!isDigit && prev && prev.toLowerCase() === ch.toLowerCase()) continue;
    result += ch;
  }
  return result;
}

// § Label creation, steps 1-3 — the full candidate string a street's label
// is drawn from: the name is compacted first (see Feature name
// compacting), the stem's leading direction word (if any) is abbreviated,
// stem and type are concatenated directly (not space-joined -- any
// doubled letter at that boundary is meant to collapse, not be
// protected), then vowels are stripped (per the single-letter-word /
// direction-token exceptions), every space and punctuation character is
// removed, repeated letters are compressed, and the result is lowercased.
function labelCandidateString(name) {
  const { stem, type } = compactFeatureName(name);
  const candidate = abbreviateLeadingDirection(stem) + type;
  const vowelsStripped = stripVowelsPreservingSingleLetterWords(candidate);
  const cleaned = vowelsStripped.replace(/[^A-Za-z0-9]/g, '');
  return compressRepeatedLetters(cleaned).toLowerCase();
}

// § Label creation, steps 4-7 — assigns every street name a unique
// 3-character label. Processes names in the given order (alphabetical, so
// output is stable/reproducible run to run) -- uniqueness resolution is
// first-come-first-served, so earlier names in the list get first claim
// on their natural 3-letter window. A candidate with 2+ digits (numbered
// streets, after Feature name compacting's ordinal conversion) tries the
// digit-anchored approach first -- a generic character-window walk over a
// number is exactly the "arbitrary and hard to interpret" case this step
// exists to avoid, since the actual digits are the single most meaningful
// part of a numbered street's name.
function assignBrailleLabels(names) {
  const used = new Set();
  const labels = new Map();

  for (const name of names) {
    const candidate = labelCandidateString(name);
    const label = findUniqueDigitAnchoredLabel(candidate, used)
      || findUniqueLabel(candidate, used)
      || findUniqueLabelWalkingMiddle(candidate, used)
      || findUniqueDigitSuffix(candidate, used);
    used.add(label);
    labels.set(name, label);
  }

  return labels;
}

// § Label creation — for a candidate string containing a run of 2+
// digits (there is at most one, since ordinal conversion only ever
// produces a single digit run per name, and neither direction nor
// street-type abbreviations introduce digits), tries a label anchored on
// those digits rather than falling through to the generic window-walk
// below. Exactly 2 digits: the pair itself is the anchor. 3 or more
// digits: try the rightmost 3 digits alone first (no letter at all --
// e.g. "West 130th Street" -> "130"); if that collides, drop to the
// rightmost 2 digits and anchor on those instead. Returns null (falling
// through to the generic algorithm) for 0 or 1 digit, or if every
// digit-anchored attempt collides.
function findUniqueDigitAnchoredLabel(candidate, used) {
  const match = candidate.match(/\d+/);
  if (!match || match[0].length < 2) return null;

  const digits = match[0];
  const start = match.index;
  const end = start + digits.length;

  if (digits.length >= 3) {
    const rightmost3 = digits.slice(-3);
    if (!used.has(rightmost3)) return rightmost3;
  }
  const anchor = digits.length >= 3 ? digits.slice(-2) : digits;
  return findUniqueDigitPairLabel(candidate, anchor, start, end, used);
}

// § Label creation — completes a fixed 2-digit anchor into a unique
// 3-character label by adding exactly one adjacent letter, checked
// against the digit run's actual position in the full candidate string
// (not the anchor's own possibly-shorter length, so a rightmost-2
// fallback still looks for its leading/trailing letter outside the
// *whole* original run, not just outside the 2 digits it's keeping).
// Leading candidates are tried first, walking forward (left to right)
// from the very start of the string toward the digits -- the earliest,
// most identifying characters first -- and only once every leading
// character is exhausted does the search move to trailing characters,
// nearest-first (already the same left-to-right order, continuing past
// the digits). Returns null if both directions are exhausted.
function findUniqueDigitPairLabel(candidate, digitAnchor, start, end, used) {
  for (let i = 0; i < start; i++) {
    const label = candidate[i] + digitAnchor;
    if (!used.has(label)) return label;
  }
  for (let i = end; i < candidate.length; i++) {
    const label = digitAnchor + candidate[i];
    if (!used.has(label)) return label;
  }
  return null;
}

// § Label creation, steps 4-5 — try the candidate string's first three
// characters; on collision, keep the first two characters fixed and walk
// only the third character forward through the rest of the candidate
// string, rather than sliding the whole 3-character window. This keeps
// same-prefix streets (e.g. "University Avenue"/"University Walk", or
// "Virginia Gardens"/"Virginia Street") looking and feeling as similar as
// the data allows -- only the one character that actually needs to differ
// changes, instead of the whole label shifting to a different, unrelated
// stretch of the name. A candidate shorter than 3 characters is padded
// with dashes (the label's only allowed punctuation, per the Label
// creation intro) rather than skipped -- there's nothing to walk through
// in that case. Returns null if every remaining character collides too,
// so the caller can fall through to the digit-suffix step.
function findUniqueLabel(candidate, used) {
  if (candidate.length < 3) {
    const label = padLabel(candidate);
    return used.has(label) ? null : label;
  }
  const prefix = candidate.slice(0, 2);
  for (let i = 2; i < candidate.length; i++) {
    const label = prefix + candidate[i];
    if (!used.has(label)) return label;
  }
  return null;
}

function padLabel(s) {
  return (s + '---').slice(0, 3);
}

// § Label creation, step 5b — every prefix-anchored window (step 5)
// collided too, so try a different anchor: keep the candidate's first and
// last characters fixed (the label's 1st and 3rd positions), and walk the
// label's middle position through the candidate string's interior
// characters. A different combinatorial space than step 5 (which only
// ever anchors the first two characters), so it can still find a unique
// label for a longer candidate string even after step 5 is exhausted.
// Returns null if that's exhausted too (or the candidate is too short to
// have a distinct first/middle/last), so the caller can fall through to
// the digit-suffix step.
function findUniqueLabelWalkingMiddle(candidate, used) {
  if (candidate.length < 3) return null;
  const first = candidate[0];
  const last = candidate[candidate.length - 1];
  for (let j = 1; j < candidate.length - 1; j++) {
    const label = first + candidate[j] + last;
    if (!used.has(label)) return label;
  }
  return null;
}

// § Label creation, step 7 — steps 5 and 6 both collided on every
// attempt, so fall back to the candidate's first two characters (padded
// with a dash if the candidate itself is shorter than 2 characters) plus
// a single trailing digit, trying 0-9 in order until one is unique.
function findUniqueDigitSuffix(candidate, used) {
  const prefix = (candidate.slice(0, 2) + '-').slice(0, 2);
  for (let digit = 0; digit <= 9; digit++) {
    const label = prefix + String(digit);
    if (!used.has(label)) return label;
  }
  // All 10 digits already taken by this exact prefix -- vanishingly
  // unlikely for any real street list, but return a guaranteed-unique
  // placeholder rather than a duplicate label.
  let n = 0;
  while (used.has(`?${n}`)) n++;
  return `?${n}`;
}

// § Label placement — constants from tmap spec.md's placement rules. The
// spec's "2 display-pixels" of whitespace is expressed in this doc's own
// dot-grid units (a "display-pixel" here means one dot, same as the
// zone-sizing math above).
const LABEL_WHITESPACE_DOTS = 2;
const LABEL_ANGLE_THRESHOLD_DEGREES = 45;

// § Label placement, step 1 — fixed edge processing order.
const LABEL_EDGE_ORDER = ['top', 'right', 'bottom', 'left'];

// § Label placement — a label's actual along-edge content span: how much
// room its own rendered dots take, not the zone's fixed depth. 8 dots for
// top/bottom (the horizontal character span -- 2 dots/char x 3 chars + 1
// dot kerning x 2 gaps, matching labelDotPositions' own charSpan exactly),
// 3 dots for left/right (just the character height, since a label always
// reads horizontally regardless of which edge it's on -- see
// labelDotPositions). This governs both same-edge whitespace and how far
// a label can reach before needing corner space; using the zone's full
// depth (LABEL_ZONE_DOT_COLS/ROWS, which already bakes in the 2-dot
// map-side padding) here double-counts that padding as if it were also
// inter-label spacing, over-restricting both.
function labelFootprintDots(edge) {
  return edge === 'top' || edge === 'bottom'
    ? LABEL_CHAR_WIDTH_DOTS * 3 + LABEL_CHAR_KERNING_DOTS * 2
    : LABEL_CHAR_HEIGHT_DOTS;
}

// § Label placement — which of the map rectangle's four edges (if any) a
// map-relative grid point sits on. Checked in LABEL_EDGE_ORDER so a
// (vanishingly unlikely) exact corner point resolves to one edge
// consistently rather than being ambiguous.
function edgeAtGridPoint(x, y, gridBounds) {
  const EPSILON = 1e-6;
  if (Math.abs(y) < EPSILON) return 'top';
  if (Math.abs(x - gridBounds.width) < EPSILON) return 'right';
  if (Math.abs(y - gridBounds.height) < EPSILON) return 'bottom';
  if (Math.abs(x) < EPSILON) return 'left';
  return null;
}

// § Label placement — every point where a way's geometry crosses one of
// the map rectangle's four edges, using the same Liang-Barsky clip
// already used for rendering (see clipSegmentToRect) -- a way's raw
// geometry routinely continues well beyond the current viewport, so a
// clipped segment endpoint that lands exactly on the rectangle boundary
// (rather than ending strictly inside it) is a genuine "this street
// continues past this edge" crossing. dx/dy is the crossing segment's own
// direction (unaffected by clipping, which only truncates a segment's
// length, not its slope), used for the angle rule.
function findEdgeCrossings(way, viewportBbox, gridBounds) {
  const crossings = [];
  const geometry = way.geometry || [];
  let prev = null;
  for (const pt of geometry) {
    const p = projectToGrid(pt.lat, pt.lon, viewportBbox);
    if (prev) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      const clipped = clipSegmentToRect(prev.x, prev.y, p.x, p.y, 0, 0, gridBounds.width, gridBounds.height);
      if (clipped && (dx !== 0 || dy !== 0)) {
        for (const corner of [[clipped.x0, clipped.y0], [clipped.x1, clipped.y1]]) {
          const edge = edgeAtGridPoint(corner[0], corner[1], gridBounds);
          if (edge) crossings.push({ edge, x: corner[0], y: corner[1], dx, dy });
        }
      }
    }
    prev = p;
  }
  return crossings;
}

// § Label placement — "intersects the active edge at more than 45
// degrees." Both top/bottom (horizontal) and left/right (vertical) edges
// reduce to the same angle-from-horizontal measurement, just compared on
// opposite sides of the 45-degree threshold: a street must run closer to
// perpendicular than parallel to the edge it's crossing. Exactly 45
// degrees fails on every edge, per the spec's "45 degrees or less" wording.
function crossingAngleOk(crossing) {
  const angleFromHorizontal = Math.atan2(Math.abs(crossing.dy), Math.abs(crossing.dx)) * 180 / Math.PI;
  if (crossing.edge === 'top' || crossing.edge === 'bottom') {
    return angleFromHorizontal > LABEL_ANGLE_THRESHOLD_DEGREES;
  }
  return angleFromHorizontal < LABEL_ANGLE_THRESHOLD_DEGREES;
}

// § Label placement — whether any part of a way's geometry is actually
// visible within the current map rectangle (as opposed to passing nearby
// or only appearing in the wider fetch square) -- used by
// visibleSegmentCounts below. Same clip as findEdgeCrossings, just
// checking for any intersection at all rather than collecting crossing
// points.
function wayHasVisiblePortion(way, viewportBbox, gridBounds) {
  const geometry = way.geometry || [];
  let prev = null;
  for (const pt of geometry) {
    const p = projectToGrid(pt.lat, pt.lon, viewportBbox);
    if (prev) {
      if (clipSegmentToRect(prev.x, prev.y, p.x, p.y, 0, 0, gridBounds.width, gridBounds.height)) return true;
    }
    prev = p;
  }
  return false;
}

// § Label placement — how many of a street's own way-segments have any
// part visible in the current viewport, per street name. Replaces the
// earlier length-based "stub street" exclusion: that rule measured the
// length of the one segment crossing a given edge, which wrongly
// penalized substantial streets whose specific edge-crossing segment
// happened to be short even though the street has plenty of other
// visible segments elsewhere. Segment count is a better proxy for "is
// this a real, significant street on the current display" -- used as a
// tie-breaker in placeLabels, not an exclusion filter, so a street is
// never outright disqualified from labeling by this alone.
function visibleSegmentCounts(ways, viewportBbox, gridBounds) {
  const counts = new Map();
  for (const way of ways) {
    const name = way.tags && way.tags.name;
    if (!name || !wayHasVisiblePortion(way, viewportBbox, gridBounds)) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

// § Label placement — every candidate label point across all four edges,
// for every currently-visible way with an assigned label. A candidate
// carries its own intrinsic pass/fail state (the angle rule) but not
// whitespace/dedup, which depend on what else gets placed and are handled
// by placeLabels below. "along" is the crossing's position along whichever
// axis that edge runs (x for top/bottom, y for left/right) -- what step
// 2's left-to-right/top-to-bottom position ordering sorts by, after
// segment count (see placeLabels).
function collectLabelCandidates(ways, viewportBbox, gridBounds, labels) {
  const segmentCounts = visibleSegmentCounts(ways, viewportBbox, gridBounds);
  const candidates = [];
  for (const way of ways) {
    const name = way.tags && way.tags.name;
    if (!name || !labels.has(name)) continue;
    const crossings = findEdgeCrossings(way, viewportBbox, gridBounds);
    if (crossings.length === 0) continue;
    for (const crossing of crossings) {
      if (!crossingAngleOk(crossing)) continue;
      const along = crossing.edge === 'top' || crossing.edge === 'bottom' ? crossing.x : crossing.y;
      candidates.push({
        name, label: labels.get(name), tier: way.tier, edge: crossing.edge, along,
        segmentCount: segmentCounts.get(name) || 0
      });
    }
  }
  return candidates;
}

// § Label placement, steps 1-5 — the placement algorithm proper. Runs two
// passes over the four edges in LABEL_EDGE_ORDER, walking tiers 1-7
// (most to least important) within each edge and candidates by visible
// segment count then position within each tier: a primary pass that skips
// any street already labeled on an earlier-processed edge (step 4, "at
// most one label"), then a final pass over the same candidates without
// that restriction, filling any room left over (step 5) -- which may
// duplicate an existing label or give a first label to a street skipped
// everywhere in the primary pass.
// Returns { top: [...], right: [...], bottom: [...], left: [...] }, each
// entry { name, label, tier, edge, along, footprint }.
function placeLabels(candidates, gridBounds, activeZones) {
  const byEdge = { top: [], right: [], bottom: [], left: [] };
  for (const c of candidates) byEdge[c.edge].push(c);

  const placed = { top: [], right: [], bottom: [], left: [] };
  const labeledNames = new Set();

  // § Braille labels — the four corners are shared, contested space, not
  // owned outright by any one zone: each corner is exactly one label's
  // worth of physical room (LABEL_ZONE_DOT_COLS x LABEL_ZONE_DOT_ROWS),
  // where the two zones meeting there could each place a label if the
  // other doesn't. Only exists when *both* contributing zones are active
  // -- if either is off, gridBounds already leaves no gap there.
  function cornerBox(horizontalEdge, verticalEdge) {
    return {
      x0: verticalEdge === 'left' ? 0 : gridBounds.offsetX + gridBounds.width,
      x1: verticalEdge === 'left' ? gridBounds.offsetX : DOT_GRID_WIDTH,
      y0: horizontalEdge === 'top' ? 0 : gridBounds.offsetY + gridBounds.height,
      y1: horizontalEdge === 'top' ? gridBounds.offsetY : DOT_GRID_HEIGHT
    };
  }

  // Which corner (and its other contributing edge) a candidate would need
  // to reach into, if its footprint extends past its own edge's map-sized
  // core range. Returns null for the common case -- fits entirely within
  // the map's own width/height, no corner involved.
  function cornerNeeded(edge, along, footprint) {
    const half = footprint / 2;
    if (edge === 'top' || edge === 'bottom') {
      if (along - half < 0) return { horizontalEdge: edge, verticalEdge: 'left', neighbor: 'left' };
      if (along + half > gridBounds.width) return { horizontalEdge: edge, verticalEdge: 'right', neighbor: 'right' };
    } else {
      if (along - half < 0) return { horizontalEdge: 'top', verticalEdge: edge, neighbor: 'top' };
      if (along + half > gridBounds.height) return { horizontalEdge: 'bottom', verticalEdge: edge, neighbor: 'bottom' };
    }
    return null;
  }

  // A placed label's absolute (full-canvas) bounding box, for checking
  // corner overlap against another edge's placements.
  function placementBox(p) {
    const half = p.footprint / 2;
    if (p.edge === 'top' || p.edge === 'bottom') {
      return {
        x0: gridBounds.offsetX + p.along - half, x1: gridBounds.offsetX + p.along + half,
        y0: p.edge === 'top' ? 0 : gridBounds.offsetY + gridBounds.height,
        y1: p.edge === 'top' ? gridBounds.offsetY : DOT_GRID_HEIGHT
      };
    }
    return {
      x0: p.edge === 'left' ? 0 : gridBounds.offsetX + gridBounds.width,
      x1: p.edge === 'left' ? gridBounds.offsetX : DOT_GRID_WIDTH,
      y0: gridBounds.offsetY + p.along - half, y1: gridBounds.offsetY + p.along + half
    };
  }

  function boxesOverlap(a, b) {
    return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  }

  // § Braille labels — a candidate fits if: it either stays within its
  // own edge's core range, or reaches into a corner that's still free (the
  // neighbor zone is active and hasn't already placed something
  // overlapping that corner -- since edges are processed in
  // LABEL_EDGE_ORDER and nothing is ever un-placed, whichever of the two
  // corner-sharing edges gets processed first effectively has "first
  // crack" at it, exactly as tried-and-not-taken); and it keeps the usual
  // whitespace gap from every other label already on its own edge.
  function fits(edge, along, footprint) {
    const corner = cornerNeeded(edge, along, footprint);
    if (corner) {
      if (!activeZones[corner.neighbor]) return false;
      const box = cornerBox(corner.horizontalEdge, corner.verticalEdge);
      for (const p of placed[corner.neighbor]) {
        if (boxesOverlap(box, placementBox(p))) return false;
      }
    }
    for (const p of placed[edge]) {
      const gap = Math.abs(along - p.along) - (footprint / 2 + p.footprint / 2);
      if (gap < LABEL_WHITESPACE_DOTS) return false;
    }
    return true;
  }

  function runPass(skipAlreadyLabeled) {
    for (const edge of LABEL_EDGE_ORDER) {
      if (!activeZones[edge]) continue;
      for (let tier = 1; tier <= MAX_TIER; tier++) {
        // Within a tier: more visible segments wins (a rough proxy for
        // "how substantial is this street on the current display" -- see
        // visibleSegmentCounts), then position order as the final,
        // deterministic tie-break.
        const tierCandidates = byEdge[edge]
          .filter((c) => c.tier === tier)
          .sort((a, b) => b.segmentCount - a.segmentCount || a.along - b.along);
        for (const c of tierCandidates) {
          if (skipAlreadyLabeled && labeledNames.has(c.name)) continue;
          const footprint = labelFootprintDots(edge);
          if (!fits(edge, c.along, footprint)) continue;
          placed[edge].push({ ...c, footprint });
          labeledNames.add(c.name);
        }
      }
    }
  }

  runPass(true);
  runPass(false);

  return placed;
}

// § Label creation — every distinct street/pathway name currently in
// lastWays, alphabetical -- the input assignBrailleLabels needs, and
// shared by on-screen/on-device label placement (below) and the SVG
// export's street metadata (see buildExportSvg), so both always agree
// on what a given name's label resolves to.
function allNamesSorted() {
  return Array.from(new Set(
    lastWays.map((way) => way.tags && way.tags.name).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
}

// § Label placement — top-level entry point: labels every street name
// currently in lastWays (per spec, uniqueness spans the whole fetch, not
// just what's visible), then places labels for whatever's actually
// visible right now against the current viewport and active label zones.
function computeLabelPlacements() {
  if (!lastBbox) return { top: [], right: [], bottom: [], left: [] };
  const labels = assignBrailleLabels(allNamesSorted());
  const viewportBbox = getViewportBbox();
  const gridBounds = mapGridBounds();
  const candidates = collectLabelCandidates(visibleWays(), viewportBbox, gridBounds, labels);
  return placeLabels(candidates, gridBounds, labelZones);
}

// § Label placement — a label character's dot pattern within its own 2
// (dot-column) x 3 (dot-row) cell, decoded from the same NABCC table used
// for the message display (see NABCC below). Every character a label can
// actually contain -- lowercase letters, digits, dash -- stays within
// NABCC's low 6 bits (confirmed by inspection: none exceed 0x3F), so dots
// 7/8 (bits 6/7) never apply here; this only decodes bits 0-5.
// bit0=dot1(col0,row0) bit1=dot2(col0,row1) bit2=dot3(col0,row2)
// bit3=dot4(col1,row0) bit4=dot5(col1,row1) bit5=dot6(col1,row2)
const LABEL_DOT_BIT_POSITIONS = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]];

function labelCharacterDots(ch) {
  const code = ch.charCodeAt(0);
  const byte = (code >= 0x20 && code <= 0x7E) ? NABCC[code - 0x20] : 0x00;
  const dots = [];
  for (let bit = 0; bit < 6; bit++) {
    if (byte & (1 << bit)) dots.push(LABEL_DOT_BIT_POSITIONS[bit]);
  }
  return dots;
}

// § Label placement — converts one placed label into absolute dot-grid
// coordinates (the full DOT_GRID_WIDTH/HEIGHT canvas, not map-relative)
// for every "on" braille dot. A label's own 3 characters are always laid
// out horizontally (left-to-right, 1-dot kerning between each pair) --
// confirmed from the spec's zone-sizing math, where the *same* 8-dot
// character span (2+1+2+1+2) makes up the left/right zones' width too,
// meaning even a label on a vertical edge reads horizontally within its
// own narrow strip; only the zone/label's *perpendicular* dimension
// differs by edge (see labelFootprintDots). What differs here per edge is
// just where that horizontal strip sits: spread along the edge and
// pinned to the outer (non-map) side for top/bottom, or fixed near the
// zone's own outer side and positioned along the edge by "along" for
// left/right.
const LABEL_CHAR_WIDTH_DOTS = 2;
const LABEL_CHAR_HEIGHT_DOTS = 3;
const LABEL_CHAR_KERNING_DOTS = 1;
const LABEL_MAP_PADDING_DOTS = 2;

// § Braille labels — the top-left anchor a label's 3-character block is
// laid out from, shared by the braille-dot geometry below (still used by
// the tactile raster) and the on-screen print-text rendering (see
// drawLabelContent), so the two can never drift out of sync on where a
// label actually sits.
function labelBaseXY(placement, gridBounds) {
  const charSpan = LABEL_CHAR_WIDTH_DOTS * 3 + LABEL_CHAR_KERNING_DOTS * 2; // 8
  const horizontal = placement.edge === 'top' || placement.edge === 'bottom';

  let baseX, baseY;
  if (horizontal) {
    const centerX = gridBounds.offsetX + placement.along;
    baseX = Math.round(centerX - charSpan / 2);
    baseY = placement.edge === 'top'
      ? 0
      : gridBounds.offsetY + gridBounds.height + LABEL_MAP_PADDING_DOTS;
  } else {
    const centerY = gridBounds.offsetY + placement.along;
    baseX = placement.edge === 'left'
      ? 0
      : gridBounds.offsetX + gridBounds.width + LABEL_MAP_PADDING_DOTS;
    baseY = Math.round(centerY - LABEL_CHAR_HEIGHT_DOTS / 2);
  }
  return { baseX, baseY, charSpan };
}

function labelDotPositions(placement, gridBounds) {
  const { baseX, baseY } = labelBaseXY(placement, gridBounds);
  const dots = [];
  placement.label.split('').forEach((ch, i) => {
    const charX = baseX + i * (LABEL_CHAR_WIDTH_DOTS + LABEL_CHAR_KERNING_DOTS);
    for (const [col, row] of labelCharacterDots(ch)) {
      dots.push({ x: charX + col, y: baseY + row });
    }
  });
  return dots;
}

// § Braille labels — the on-screen SVG shows each placed label as plain
// print text rather than its braille dot pattern -- the tactile raster
// (drawLabelDotsToPixels below) is untouched and still draws real
// braille, since these are two genuinely separate rendering pipelines
// feeding two different audiences (sighted and blind users looking at
// the same map together). Positioned at the same top-left anchor
// labelDotPositions uses for the equivalent braille block (labelBaseXY),
// horizontally centered within that block's own footprint -- print text
// doesn't need to match the dot pattern's per-character spacing. Font
// size is derived from the zone's fixed dot-row height
// (LABEL_CHAR_HEIGHT_DOTS), not hardcoded, so it stays correct if that
// constant ever changes.
function drawLabelContent(svgNs, placements, gridBounds) {
  const group = document.createElementNS(svgNs, 'g');
  const rowHeightUnits = LABEL_CHAR_HEIGHT_DOTS * SVG_UNITS_PER_DOT;
  const fontSizeUnits = rowHeightUnits * 0.85;
  for (const edge of LABEL_EDGE_ORDER) {
    for (const placement of placements[edge]) {
      const { baseX, baseY, charSpan } = labelBaseXY(placement, gridBounds);
      const text = document.createElementNS(svgNs, 'text');
      const centerXUnits = (baseX + charSpan / 2) * SVG_UNITS_PER_DOT;
      const baselineYUnits = baseY * SVG_UNITS_PER_DOT + rowHeightUnits - (rowHeightUnits - fontSizeUnits) / 2;
      text.setAttribute('x', centerXUnits.toFixed(1));
      text.setAttribute('y', baselineYUnits.toFixed(1));
      text.setAttribute('font-size', fontSizeUnits.toFixed(1));
      text.setAttribute('class', 'label-text');
      text.textContent = placement.label;
      group.appendChild(text);
    }
  }
  mapSvg.appendChild(group);
}

// § Braille labels — same geometry as drawLabelContent, but drawn straight
// into the tactile raster's pixel buffer instead of SVG circles. scaleX/
// scaleY match the ones rasterizeMapToPixels already computes for
// everything else, in case the connected device ever reports a
// resolution other than the expected 60x40.
function drawLabelDotsToPixels(pixels, w, h, placements, gridBounds, scaleX, scaleY) {
  for (const edge of LABEL_EDGE_ORDER) {
    for (const placement of placements[edge]) {
      for (const dot of labelDotPositions(placement, gridBounds)) {
        setGridPixel(pixels, w, h, Math.round(dot.x * scaleX), Math.round(dot.y * scaleY));
      }
    }
  }
}

// § Braille labels — draws each active zone as a bordered region (see
// svgMapRect/mapGridBounds for the geometry). Label content itself is
// drawn separately, on top, by drawLabelContent -- this just reserves and
// shows the zone's own space, so it still renders (empty) even before a
// map is loaded or if a zone happens to have no labels placed in it.
function drawLabelZoneRects(svgNs) {
  const leftW = labelZones.left ? LABEL_ZONE_DOT_COLS * SVG_UNITS_PER_DOT : 0;
  const rightW = labelZones.right ? LABEL_ZONE_DOT_COLS * SVG_UNITS_PER_DOT : 0;
  const topH = labelZones.top ? LABEL_ZONE_DOT_ROWS * SVG_UNITS_PER_DOT : 0;
  const bottomH = labelZones.bottom ? LABEL_ZONE_DOT_ROWS * SVG_UNITS_PER_DOT : 0;

  const addRect = (x, y, width, height) => {
    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('x', x.toFixed(1));
    rect.setAttribute('y', y.toFixed(1));
    rect.setAttribute('width', width.toFixed(1));
    rect.setAttribute('height', height.toFixed(1));
    rect.setAttribute('class', 'label-zone');
    mapSvg.appendChild(rect);
  };

  // Left/right zones span the full display height; top/bottom fill the
  // space left between them -- matches mapGridBounds' offset/width math.
  if (labelZones.left) addRect(0, 0, leftW, SVG_HEIGHT);
  if (labelZones.right) addRect(SVG_WIDTH - rightW, 0, rightW, SVG_HEIGHT);
  if (labelZones.top) addRect(leftW, 0, SVG_WIDTH - leftW - rightW, topH);
  if (labelZones.bottom) addRect(leftW, SVG_HEIGHT - bottomH, SVG_WIDTH - leftW - rightW, bottomH);
}

// § Braille labels — streets/anchor go in a group clipped to the map's
// sub-rect (see svgMapRect), not just the full 600x400 canvas. Way geometry
// routinely extends well beyond the current viewport (lastBbox is the whole
// fetched square; bbox here is just the visible window within it), so
// without this a polyline can run straight through a reserved label zone on
// its way to an off-screen point -- previously only hidden from view by the
// zone rect's own fill/z-order, not actually excluded.
function renderStreetsAndAnchor(svgNs, bbox, ways, anchorLat, anchorLon) {
  const rect = svgMapRect();
  const clipPath = document.createElementNS(svgNs, 'clipPath');
  clipPath.setAttribute('id', 'map-clip');
  const clipRect = document.createElementNS(svgNs, 'rect');
  clipRect.setAttribute('x', rect.x.toFixed(1));
  clipRect.setAttribute('y', rect.y.toFixed(1));
  clipRect.setAttribute('width', rect.width.toFixed(1));
  clipRect.setAttribute('height', rect.height.toFixed(1));
  clipPath.appendChild(clipRect);
  mapSvg.appendChild(clipPath);

  const group = document.createElementNS(svgNs, 'g');
  group.setAttribute('clip-path', 'url(#map-clip)');
  mapSvg.appendChild(group);

  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    const points = way.geometry
      .map((pt) => {
        const { x, y } = projectToSvg(pt.lat, pt.lon, bbox);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    const line = document.createElementNS(svgNs, 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('class', 'street');
    group.appendChild(line);
  }

  // § POIs — every POI marker (anchor and additional alike) is a solid
  // square, all corners intact -- unlike the cursor's hollow ring, so the
  // two read as clearly distinct shapes both on screen and by touch. Sized
  // to the same 3-dot footprint as the tactile marker (see drawSquarePixels)
  // for a consistent visual/tactile scale.
  // § Editing the Map — a POI unchecked in the Edit Map dialog is skipped
  // here, same as a hidden street above. § Command / hotkey mapping — also
  // skipped entirely while cursorOnlyMode (the 0 hotkey) is active, same
  // as visibleWays()/visiblePois() -- these two checks are direct (not
  // routed through visiblePois()) only because this loop needs to keep the
  // anchor/additional marker-class distinction that function doesn't carry.
  if (!cursorOnlyMode && !hiddenPoiNames.has(lastAnchorName)) {
    const anchorPoint = projectToSvg(anchorLat, anchorLon, bbox);
    group.appendChild(createPoiMarkerSvg(svgNs, anchorPoint.x, anchorPoint.y, 'anchor-poi'));
  }

  if (!cursorOnlyMode) {
    for (const poi of additionalPois) {
      if (hiddenPoiNames.has(poi.name)) continue;
      const p = projectToSvg(poi.lat, poi.lon, bbox);
      group.appendChild(createPoiMarkerSvg(svgNs, p.x, p.y, 'additional-poi'));
    }
  }
}

function createPoiMarkerSvg(svgNs, x, y, className) {
  const size = POI_MARKER_DOTS * SVG_UNITS_PER_DOT;
  const rect = document.createElementNS(svgNs, 'rect');
  rect.setAttribute('x', (x - size / 2).toFixed(1));
  rect.setAttribute('y', (y - size / 2).toFixed(1));
  rect.setAttribute('width', size);
  rect.setAttribute('height', size);
  rect.setAttribute('class', className);
  return rect;
}

// Centers the on-screen cursor circle on the current grid cell. Position is
// additionally clamped by the circle's own radius so it always renders
// fully intact, never clipped by the SVG viewBox edge -- this is purely a
// rendering safeguard on top of cursorGridPosition's grid-space clamp
// (which keepCursorInView already tries hard to avoid ever needing).
function updateCursorVisual() {
  const viewportBbox = getViewportBbox();
  const grid = cursorGridPosition(viewportBbox);
  if (!grid) return;
  const rect = svgMapRect();
  const cx = clamp(rect.x + (grid.x + 0.5) * SVG_UNITS_PER_DOT, rect.x + CURSOR_SVG_RADIUS, rect.x + rect.width - CURSOR_SVG_RADIUS);
  const cy = clamp(rect.y + (grid.y + 0.5) * SVG_UNITS_PER_DOT, rect.y + CURSOR_SVG_RADIUS, rect.y + rect.height - CURSOR_SVG_RADIUS);
  cursorSvg.setAttribute('cx', cx.toFixed(1));
  cursorSvg.setAttribute('cy', cy.toFixed(1));
}

function distanceToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

// § Cursor and hit testing — streets within CURSOR_HIT_RADIUS grid units of
// the cursor's center are "current." Unique names only, joined with " & ".
function currentObjectNames() {
  const viewportBbox = getViewportBbox();
  const cursorGrid = cursorGridPosition(viewportBbox);
  if (!cursorGrid) return null;
  const names = new Set();
  // § Editing the Map — a street hidden via the Edit Map dialog isn't
  // "feelable" via the cursor either.
  const ways = visibleWays();
  for (const way of ways) {
    const name = way.tags && way.tags.name;
    if (!name || !way.geometry || way.geometry.length < 2) continue;
    let prev = null;
    for (const pt of way.geometry) {
      const p = projectToGrid(pt.lat, pt.lon, viewportBbox);
      if (prev) {
        const d = distanceToSegment(cursorGrid.x, cursorGrid.y, prev.x, prev.y, p.x, p.y);
        if (d <= CURSOR_HIT_RADIUS) {
          names.add(name);
          break;
        }
      }
      prev = p;
    }
  }

  // § POIs — POI markers are point objects, hit the same way as a street
  // vertex: within CURSOR_HIT_RADIUS grid units of the cursor's center.
  // § Editing the Map — a POI hidden via the Edit Map dialog isn't
  // "feelable" either, hence visiblePois() rather than allPois() here.
  for (const poi of visiblePois()) {
    const p = projectToGrid(poi.lat, poi.lon, viewportBbox);
    if (Math.hypot(cursorGrid.x - p.x, cursorGrid.y - p.y) <= CURSOR_HIT_RADIUS) {
      names.add(poi.name);
    }
  }

  if (!names.size) return null;
  const nameList = Array.from(names);
  // § Cursor and hit testing — a single feature under the cursor is
  // announced in compacted form (stem + type, e.g. "9th St"); with multiple
  // features, only the compacted stem is used for each (no type), joined
  // by " and ", to keep the message from ballooning with repeated
  // street-type words when several names are packed together.
  if (nameList.length === 1) {
    return compactedDisplayName(nameList[0]);
  }
  // § Cursor and hit testing — sorted alphabetically by stem (not left in
  // whatever order the hit-test scan happened to find them) so the exact
  // same set of objects always produces the exact same message, no matter
  // which one the scan reaches first as the cursor moves pixel by pixel
  // through an intersection -- otherwise "Virginia and Shattuck" and
  // "Shattuck and Virginia" would both fire for the same real-world
  // situation, one right after the other, as a spurious re-announcement.
  const stems = nameList.map((name) => compactFeatureName(name).stem);
  stems.sort((a, b) => a.localeCompare(b));
  return stems.join(' and ');
}

// § New Pin / Edit Pin — the POI-only counterpart to currentObjectNames()'s
// hit-test loop above: returns the single pin under the cursor (anchor or
// additional), or null if none. Used to decide whether p/a/the Map Menu's
// pin item open New Pin or Edit Pin (see openNewOrEditPinDialog) -- pins
// are far enough apart in practice that "first hit wins" never matters,
// but checking the anchor before additionalPois (same order as
// renderPoiList/allPois) makes it deterministic if it ever did. Same
// hidden-via-Edit-Map and cursor-only-mode exclusions as visiblePois().
function currentPoi() {
  const viewportBbox = getViewportBbox();
  const cursorGrid = cursorGridPosition(viewportBbox);
  if (!cursorGrid || cursorOnlyMode) return null;
  const isUnderCursor = (lat, lon) => {
    const p = projectToGrid(lat, lon, viewportBbox);
    return Math.hypot(cursorGrid.x - p.x, cursorGrid.y - p.y) <= CURSOR_HIT_RADIUS;
  };
  if (lastAnchorName && !hiddenPoiNames.has(lastAnchorName) && isUnderCursor(lastAnchorLat, lastAnchorLon)) {
    return { isAnchor: true, index: -1, name: lastAnchorName, lat: lastAnchorLat, lon: lastAnchorLon };
  }
  for (let i = 0; i < additionalPois.length; i++) {
    const poi = additionalPois[i];
    if (hiddenPoiNames.has(poi.name)) continue;
    if (isUnderCursor(poi.lat, poi.lon)) {
      return { isAnchor: false, index: i, name: poi.name, lat: poi.lat, lon: poi.lon };
    }
  }
  return null;
}

// § POIs — the anchor plus every additional POI, as a flat list of
// { name, lat, lon }.
function allPois() {
  const pois = [];
  if (lastAnchorName) pois.push({ name: lastAnchorName, lat: lastAnchorLat, lon: lastAnchorLon });
  pois.push(...additionalPois);
  return pois;
}

// § Editing the Map — allPois() minus whatever the user has unchecked in
// the dialog. allPois() itself stays unfiltered so the dialog can still
// list a hidden POI (and let it be turned back on); everywhere a POI is
// actually shown, hit-tested, or brailled uses this instead. cursorOnlyMode
// (the 0 hotkey) short-circuits this to nothing without touching
// hiddenPoiNames itself -- see its declaration for why.
function visiblePois() {
  if (cursorOnlyMode) return [];
  return allPois().filter((poi) => !hiddenPoiNames.has(poi.name));
}

// § Editing the Map — lastWays minus any manually-hidden street/pathway
// name, ANDed with a Map Complexity cutoff (mapComplexityIndex by default).
// These are two independent filters, not one merged set: a manually-hidden
// street stays hidden at every complexity level, and raising/lowering
// complexity never touches hiddenStreetNames. lastWays itself stays
// unfiltered for the same reason as visiblePois() above. cursorOnlyMode
// short-circuits this the same way it does visiblePois().
// § Auto Simplification — the optional complexityIndex parameter lets
// resolveAutoComplexityIndex evaluate a hypothetical level's visible ways
// (for density-testing candidates) without touching the real
// mapComplexityIndex; every existing caller omits it and gets today's
// behavior unchanged.
function visibleWays(complexityIndex = mapComplexityIndex) {
  if (cursorOnlyMode) return [];
  const maxTier = MAP_COMPLEXITY_LEVELS[complexityIndex].maxTier;
  return lastWays.filter((way) =>
    !hiddenStreetNames.has(way.tags && way.tags.name) &&
    way.tier <= maxTier
  );
}

// § Download to Local SVG — lastWays/allPois() minus only explicitly
// hidden features. Deliberately its own filter, not visibleWays()/
// visiblePois(): the export represents the underlying map data, not the
// current display, so neither Map Complexity's tier cutoff nor
// cursorOnlyMode's temporary "show only the cursor" display trick should
// affect what's in the file -- only Hidden Features (an explicit,
// persistent user decision) does.
function exportVisibleWays() {
  return lastWays.filter((way) => !hiddenStreetNames.has(way.tags && way.tags.name));
}

function exportVisiblePois() {
  return allPois().filter((poi) => !hiddenPoiNames.has(poi.name));
}

// § Download to Local SVG — arbitrary round canvas size, unrelated to the
// Dot Pad's dot-grid units -- this file has no physical-device audience.
const EXPORT_SVG_SIZE = 1000;

// § Download to Local SVG — projects lat/lon into the export's own
// canvas, scoped to the full fetched square (lastBbox) rather than the
// current viewport, so the file always shows the complete fetched area
// regardless of what's currently panned into view on screen.
function projectToExportUnits(lat, lon) {
  return {
    x: ((lon - lastBbox.west) / (lastBbox.east - lastBbox.west)) * EXPORT_SVG_SIZE,
    y: ((lastBbox.north - lat) / (lastBbox.north - lastBbox.south)) * EXPORT_SVG_SIZE
  };
}

// § Download to Local SVG — builds the export document per tmap spec.md's
// own section: full fetched extent (not the current viewport/pan/scale),
// Hidden Features excluded but Map Complexity ignored, no placement/dot/
// zone geometry, streets grouped by (name, highway, tier) with metadata
// attributes, POIs with just their name. Detached from the live page's
// own SVG -- built fresh each time, never appended to the DOM. Returns
// null if there's no map loaded yet.
function buildExportSvg() {
  if (!lastBbox) return null;
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${EXPORT_SVG_SIZE} ${EXPORT_SVG_SIZE}`);
  svg.setAttribute('width', EXPORT_SVG_SIZE);
  svg.setAttribute('height', EXPORT_SVG_SIZE);

  // Basic default styling, embedded directly so the file is viewable on
  // its own without an external stylesheet.
  const style = document.createElementNS(svgNs, 'style');
  style.textContent = '.street { fill: none; stroke: #555; stroke-width: 1.5; } .poi { fill: #1a1a1a; }';
  svg.appendChild(style);

  const labels = assignBrailleLabels(allNamesSorted());

  // Group by (name, highway, tier) -- a name legitimately spanning more
  // than one highway class or tier (e.g. a mix of residential and
  // footway segments sharing a name) gets a separate group per
  // combination, rather than merging data that doesn't actually
  // describe the same kind of way.
  const groups = new Map();
  for (const way of exportVisibleWays()) {
    const name = way.tags && way.tags.name;
    if (!name || !way.geometry || way.geometry.length < 2) continue;
    const highway = (way.tags && way.tags.highway) || '';
    const key = `${name} ${highway} ${way.tier}`;
    if (!groups.has(key)) groups.set(key, { name, highway, tier: way.tier, ways: [] });
    groups.get(key).ways.push(way);
  }

  for (const { name, highway, tier, ways } of groups.values()) {
    const { stem, type } = compactFeatureName(name);
    const g = document.createElementNS(svgNs, 'g');
    g.setAttribute('data-name', name);
    g.setAttribute('data-stem', stem);
    g.setAttribute('data-type', type);
    g.setAttribute('data-label', labels.get(name) || '');
    g.setAttribute('data-highway', highway);
    g.setAttribute('data-tier', String(tier));
    for (const way of ways) {
      const points = way.geometry
        .map((pt) => {
          const p = projectToExportUnits(pt.lat, pt.lon);
          return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        })
        .join(' ');
      const line = document.createElementNS(svgNs, 'polyline');
      line.setAttribute('points', points);
      line.setAttribute('class', 'street');
      g.appendChild(line);
    }
    svg.appendChild(g);
  }

  const poiSize = EXPORT_SVG_SIZE * 0.02;
  for (const poi of exportVisiblePois()) {
    const p = projectToExportUnits(poi.lat, poi.lon);
    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('x', (p.x - poiSize / 2).toFixed(1));
    rect.setAttribute('y', (p.y - poiSize / 2).toFixed(1));
    rect.setAttribute('width', poiSize.toFixed(1));
    rect.setAttribute('height', poiSize.toFixed(1));
    rect.setAttribute('data-name', poi.name);
    rect.setAttribute('class', 'poi');
    svg.appendChild(rect);
  }

  return svg;
}

// § Download to Local SVG — filesystem-safe filename, since the anchor's
// short address (spaces, commas) isn't guaranteed clean.
function sanitizeExportFilename(s) {
  return s.replace(/[\\/:*?"<>|]/g, '').trim();
}

// § Download to Local SVG — serializes buildExportSvg's document and
// triggers a browser download, named after the anchor's short address --
// there's no user-provided "map name" for this quick-download path,
// unlike My Archives.
function downloadExportSvg() {
  const svg = buildExportSvg();
  if (!svg) return;
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
  const blob = new Blob([xml], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${sanitizeExportFilename(lastAnchorName)}.svg`;
  link.click();
  URL.revokeObjectURL(url);
}

btnDownloadSvg.addEventListener('click', () => {
  if (btnDownloadSvg.getAttribute('aria-disabled') === 'true') return;
  closeMainMenu({ focusButton: true });
  downloadExportSvg();
});

// § Footer — opens a new GitHub issue against this repo in a new tab, so
// filing a bug doesn't lose the current map/cursor state on this page.
btnFileIssue.addEventListener('click', () => {
  window.open('https://github.com/touchout-org/tmap/issues/new', '_blank', 'noopener,noreferrer');
});

// § Cursor and hit testing — send pacing. Every cursor move used to
// trigger an immediate full clear-then-redraw graphics write AND an
// immediate message-line write, with no minimum interval -- under rapid
// keying (including OS keyboard auto-repeat) this could fire many times a
// second, which is what made the display get sluggish/confused. Scoped to
// pure cursor moves only: the general renderScene() redraw path (pan,
// scale, label toggles, edits) is untouched, still an immediate full
// clear+redraw, since those are comparatively rare, deliberate actions,
// not a rapid-fire input stream.
//   - Coalescing: a trailing-edge throttle collapses a burst of rapid
//     moves into one deferred send using whatever state is current when
//     it actually fires, instead of sending once per keystroke.
//   - The clear pass is dropped for these coalesced graphics sends
//     specifically -- a full frame already completely describes the
//     desired state (every off pixel is an explicit 0 in the packed
//     data), so a preceding all-zero write is pure waste here.
const CURSOR_SEND_INTERVAL_MS = 80; // tune against real hardware

function createCoalescer(intervalMs, flush) {
  let lastSentAt = -Infinity; // guarantees the very first call in this coalescer's lifetime sends immediately
  let timer = null;
  let pending;
  return function schedule(payload) {
    pending = payload;
    const now = performance.now();
    const elapsed = now - lastSentAt;
    if (elapsed >= intervalMs && timer === null) {
      lastSentAt = now;
      flush(payload);
      return;
    }
    if (timer === null) {
      const wait = Math.max(0, intervalMs - elapsed);
      timer = setTimeout(() => {
        timer = null;
        lastSentAt = performance.now();
        flush(pending);
      }, wait);
    }
  };
}

const scheduleCursorGraphicSend = createCoalescer(CURSOR_SEND_INTERVAL_MS, () => {
  if (currentDevice) sendGraphicToDevice(currentDevice, { skipClear: true });
});

// § Cursor and hit testing — the message-line counterpart: skips the
// device resend entirely when the announced text hasn't changed (sweeping
// the cursor across open space between features previously re-sent the
// same blank/unchanged message every single move), and coalesces genuine
// changes the same way as the graphics send above. Dedup is checked at
// flush time (against the last text actually sent), not at schedule time,
// so a quick back-and-forth that nets out to no real change doesn't
// re-announce a stale intermediate value.
let lastCursorAnnouncedText = null;
const scheduleCursorMessageSend = createCoalescer(CURSOR_SEND_INTERVAL_MS, (text) => {
  if (text === lastCursorAnnouncedText) return;
  lastCursorAnnouncedText = text;
  setMessage(text);
});

// § Command / hotkey mapping — cursor moves one display pixel per press, no
// acceleration. Shared by both the arrow keys and the Dot Pad's dots 3/2/5/6.
function moveCursor(dx, dy) {
  const viewportBbox = getViewportBbox();
  const current = cursorGridPosition(viewportBbox);
  if (!current) return;
  const b = mapGridBounds();
  const newGridX = clamp(current.x + dx, 0, b.width - 1);
  const newGridY = clamp(current.y + dy, 0, b.height - 1);

  // § Cursor and hit testing — hitting the edge of the viewport pans
  // instead of stopping there, inheriting normal Pan Behavior as-is
  // (including Edge of Map, tone and all, if that pan would itself exceed
  // the fetched data). moveCursor is always called with exactly one of
  // dx/dy nonzero, so the sign of whichever is nonzero gives the direction.
  if (newGridX === current.x && newGridY === current.y) {
    const direction = dx < 0 ? 'west' : dx > 0 ? 'east' : dy < 0 ? 'north' : 'south';
    panMap(direction);
    return;
  }

  const newPos = gridToLatLon(newGridX, newGridY, viewportBbox);
  cursorLat = newPos.lat;
  cursorLon = newPos.lon;
  updateCursorVisual();

  // § Cursor and hit testing — nothing under the cursor blanks the message
  // display rather than announcing "No street": an absence isn't worth
  // interrupting/re-announcing over, especially while sweeping the cursor
  // across open space between features.
  scheduleCursorMessageSend(currentObjectNames() || '');
  scheduleCursorGraphicSend();
}

// § Pan Behavior — an explicit pan carries the cursor's fixed real-world
// position along with it if (and only if) the pan would otherwise push that
// position past the edge OPPOSITE the pan direction (the "trailing" edge).
// Without this, keepCursorInView (called from refreshMap right after) would
// see the cursor fall outside the new viewport and silently shift the
// viewport back toward it -- fighting the pan the user just asked for, with
// no Edge of Map message since panMap's own edge check already passed. From
// the user's perspective, repeated presses in the same direction just stop
// doing anything once the cursor is close enough to the trailing edge.
//
// This deliberately only fires for the trailing edge: a cursor pinned at
// the LEADING edge (e.g. from moveCursor's own edge-triggered pan) is left
// untouched, since that's the existing, correct behavior -- the cursor
// naturally ends up further from that edge as the viewport moves under it.
// Shifting by exactly latStep/lonStep (the same amount the viewport itself
// just moved) restores the cursor to the same position relative to the new
// viewport that it had relative to the old one, which was already safely
// in view -- so keepCursorInView finds nothing left to correct.
function carryCursorPastTrailingEdge(direction, latStep, lonStep) {
  if (cursorLat === null) return;
  const viewportBbox = getViewportBbox();
  if (!viewportBbox) return;
  const b = mapGridBounds();
  const p = projectToGrid(cursorLat, cursorLon, viewportBbox);

  if (direction === 'south' && p.y < 0) {
    cursorLat -= latStep;
  } else if (direction === 'north' && p.y > b.height - 1) {
    cursorLat += latStep;
  } else if (direction === 'east' && p.x < 0) {
    cursorLon += lonStep;
  } else if (direction === 'west' && p.x > b.width - 1) {
    cursorLon -= lonStep;
  }
}

// § Pan Behavior — moves the viewport by panAmountFraction of its current
// width/height, via viewportSizeFeet() -- which is already derived from
// mapGridBounds()'s zone-shrunk dot dimensions, not the fixed DOT_GRID_
// WIDTH/HEIGHT canvas. So a pan is always panAmountFraction of whatever's
// actually currently visible: turning on a label zone shrinks the
// effective pan distance right along with the viewport it shrinks,
// with no separate handling needed here. Verified 2026-07-15: 412ft
// baseline pan dropped to 361ft with the Top zone active, matching the
// zone's 35/40 dot-row reduction (412 * 35/40 = 360.5) almost exactly.
// Rejected (viewport unchanged) if the move would push the viewport past
// the edge of the fetched data; the message field reports "Edge of Map"
// and a tone plays (see § Sound cues), per spec. This is a tone from the
// computer's own speakers, not the physical Dot Pad beeping -- the
// vendored SDK doesn't expose a device-side beep/vibrate.
// § Pan Behavior — a POI marker landing with its footprint straddling a
// map/label-zone boundary renders half in the map, half in the zone --
// a visible clipping glitch. A pan along one axis can only ever move a
// marker across the pair of edges on that same axis (a north/south pan
// only affects the top/bottom boundary, an east/west pan only left/
// right), so only that axis needs checking. Only an *active* zone's
// boundary counts -- with no zone there, a marker running past the bare
// canvas edge is already cleanly clipped by the SVG's own viewBox, no
// glitch to avoid. Checks every currently-visible POI (see visiblePois);
// if any marker would straddle, nudges the candidate center by just
// enough to clear it -- landing fully inside the map or fully past the
// boundary, whichever is the smaller (nearer) move.
function nudgeToAvoidPoiClipping(direction, lat, lon) {
  const horizontal = direction === 'east' || direction === 'west';
  const b = mapGridBounds();
  // insideSign is which sign of (position - boundary) means "inside the
  // map" for that edge -- opposite for the near edge (0) vs. the far edge
  // (width/height), since the map sits between them.
  const edges = horizontal
    ? [
        { active: labelZones.left, boundary: 0, insideSign: 1 },
        { active: labelZones.right, boundary: b.width, insideSign: -1 }
      ]
    : [
        { active: labelZones.top, boundary: 0, insideSign: 1 },
        { active: labelZones.bottom, boundary: b.height, insideSign: -1 }
      ];

  const halfMarker = POI_MARKER_DOTS / 2;
  const clearance = halfMarker + 0.05; // just past the boundary, not exactly on it
  const bbox = viewportBboxForCenter(lat, lon);
  let dotShift = 0;

  outer:
  for (const poi of visiblePois()) {
    const pos = mapRelativeDotPosition(poi.lat, poi.lon, bbox);
    const value = horizontal ? pos.x : pos.y;
    for (const edge of edges) {
      if (!edge.active) continue;
      const dist = value - edge.boundary;
      if (Math.abs(dist) >= halfMarker) continue;
      const toInside = edge.insideSign * clearance - dist;
      const toOutside = -edge.insideSign * clearance - dist;
      dotShift = Math.abs(toInside) <= Math.abs(toOutside) ? toInside : toOutside;
      break outer;
    }
  }

  if (dotShift === 0) return { lat, lon };

  const { widthFt, heightFt } = viewportSizeFeet();
  if (horizontal) {
    const shiftFt = dotShift * (widthFt / b.width);
    return { lat, lon: lon + feetToLonDelta(shiftFt, lat) };
  }
  const shiftFt = dotShift * (heightFt / b.height);
  return { lat: lat - feetToLatDelta(shiftFt), lon };
}

function panMap(direction) {
  if (!lastBbox || viewportCenterLat === null) return;
  const { widthFt, heightFt } = viewportSizeFeet();
  const latStep = feetToLatDelta(heightFt * panAmountFraction);
  const lonStep = feetToLonDelta(widthFt * panAmountFraction, viewportCenterLat);

  let newLat = viewportCenterLat;
  let newLon = viewportCenterLon;
  if (direction === 'north') newLat += latStep;
  else if (direction === 'south') newLat -= latStep;
  else if (direction === 'east') newLon += lonStep;
  else if (direction === 'west') newLon -= lonStep;

  ({ lat: newLat, lon: newLon } = nudgeToAvoidPoiClipping(direction, newLat, newLon));

  const halfLat = feetToLatDelta(heightFt / 2);
  const halfLon = feetToLonDelta(widthFt / 2, newLat);
  const exceedsEdge =
    newLat + halfLat > lastBbox.north + 1e-9 ||
    newLat - halfLat < lastBbox.south - 1e-9 ||
    newLon + halfLon > lastBbox.east + 1e-9 ||
    newLon - halfLon < lastBbox.west - 1e-9;

  if (exceedsEdge) {
    setMessage('Edge of Map');
    playEdgeTone();
    return;
  }

  viewportCenterLat = newLat;
  viewportCenterLon = newLon;
  carryCursorPastTrailingEdge(direction, latStep, lonStep);
  refreshMap();
  announcePositionRelativeToAnchor();
}

// § Scale behavior — steps through SCALE_PRESETS_FT; delta is +1 ("[",
// increase scale/zoom out) or -1 ("]", decrease scale/zoom in).
function changeScale(delta) {
  setScaleIndex(scaleIndex + delta);
}

// Form controls (the search field, POI/scale dropdowns, tuning number
// fields, dialog checkboxes) all have their own meaning for arrow keys and
// letter keys -- the app-level hotkey handler below must never compete with
// them, or e.g. arrowing through the POI dropdown also moves the map
// cursor. Checking the focused element's tag name (rather than listing
// specific IDs) covers every current and future form control uniformly.
// role="menuitem" gets the same treatment for the same reason: the Main
// Menu's own arrow/Home/End/Escape keys (see openMainMenu et al. above)
// would otherwise fire alongside the map's arrow-key cursor movement while
// a menu item has focus.
// § Street Abbreviation Key (Issue #1's "map key") — does any segment of a
// way's geometry actually cross into the current viewport rect, in plain
// lon/lat space? Reuses the Liang-Barsky clip already written for pixel
// rasterization (see clipSegmentToRect) rather than a separate geometry
// check -- it's a generic rectangle-clip, so feeding it lon/lat instead of
// device pixels works identically. visibleWays()/visiblePois() alone only
// know about Map Complexity/Hidden Features, not panning/zoom, so this is
// the missing third filter.
function wayIntersectsViewport(way, bbox) {
  if (!way.geometry || way.geometry.length < 2) return false;
  let prev = null;
  for (const pt of way.geometry) {
    if (prev && clipSegmentToRect(prev.lon, prev.lat, pt.lon, pt.lat, bbox.west, bbox.south, bbox.east, bbox.north)) {
      return true;
    }
    prev = pt;
  }
  return false;
}

function poiInViewport(poi, bbox) {
  return poi.lon >= bbox.west && poi.lon <= bbox.east && poi.lat >= bbox.south && poi.lat <= bbox.north;
}

// § Street Abbreviation Key — every POI and distinct street name currently
// visible in the viewport, POIs first (list order, anchor included),
// streets alphabetical by their full/raw name (not the compacted stem --
// the point of this list is showing the complete name behind an
// abbreviation, per Issue #1). A street's label comes from
// assignBrailleLabels(allNamesSorted()), the exact same call the tactile
// map's own label placement uses, so this list never disagrees with what's
// actually labeled on the map. Streets are deduped by name since OSM splits
// one street into many way segments at each intersection.
function computeVisibleStreetListEntries() {
  const viewportBbox = getViewportBbox();
  if (!viewportBbox) return { pois: [], streets: [] };

  const pois = visiblePois().filter((poi) => poiInViewport(poi, viewportBbox));

  const visibleNames = new Set();
  for (const way of visibleWays()) {
    const name = way.tags && way.tags.name;
    if (name && wayIntersectsViewport(way, viewportBbox)) visibleNames.add(name);
  }
  const labels = assignBrailleLabels(allNamesSorted());
  const streets = Array.from(visibleNames)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ label: labels.get(name) || '', name: compactedDisplayName(name) }));

  return { pois, streets };
}

// § Street Abbreviation Key / tactile rendering — dot-pitch constants for
// laying text out on the graphics display. Characters get the same 1-dot
// gap street labels already use (2-dot-wide cell + 1-dot gap -- a pin grid
// has no built-in separation between cells the way a real segmented
// braille display does, so without it adjacent letters can blur together).
// Stacked lines are a new case with no prior precedent (labels are always a
// single row); see the line-pitch constants below for why their gap is
// smaller than it first looks.
// Both max-per-screen figures are derived, not hardcoded, so they stay
// correct if DOT_GRID_WIDTH/HEIGHT or either gap ever changes: N whole
// pitches fit against a total budget of (total + gap) dots, since the very
// last one doesn't need a trailing gap after it.
const LIST_CHAR_WIDTH_DOTS = 2;
const LIST_CHAR_GAP_DOTS = 1;
const LIST_CHAR_PITCH_DOTS = LIST_CHAR_WIDTH_DOTS + LIST_CHAR_GAP_DOTS;
const LIST_CHARS_PER_LINE = Math.floor((DOT_GRID_WIDTH + LIST_CHAR_GAP_DOTS) / LIST_CHAR_PITCH_DOTS);
const LIST_CONTINUATION_INDENT_CHARS = 3;

// § Street Abbreviation Key — the cell height reserves a 4th dot-row for 8-dot
// computer braille (dots 7/8), but 6-dot literary braille (Grade 1/2 --
// this list's own translated text almost always is one of those) never
// sets that row, so it's already blank every time. An explicit 1-dot gap
// on top of that gives 6-dot text 2 blank rows between lines total without
// double-counting the row the content itself already leaves empty. 8-dot
// computer braille can actually use that 4th row, so its own effective gap
// is smaller -- expected, not re-tuned for here per explicit direction to
// check that case separately.
const LIST_LINE_HEIGHT_DOTS = 4;
const LIST_LINE_GAP_DOTS = 1;
const LIST_LINE_PITCH_DOTS = LIST_LINE_HEIGHT_DOTS + LIST_LINE_GAP_DOTS;
const LIST_LINES_PER_PAGE = Math.floor((DOT_GRID_HEIGHT + LIST_LINE_GAP_DOTS) / LIST_LINE_PITCH_DOTS);

// § Street Abbreviation Key — wraps one entry's cells (a 3-cell prefix --
// either a street's label or 3 blank placeholder cells for a POI's marker
// -- concatenated with " -- " + the translated name) into as many physical
// lines as it takes, breaking at a word boundary the same way the message
// window does (see chunkEndPosition). The first physical line gets the
// full line width; every line after that reserves
// LIST_CONTINUATION_INDENT_CHARS worth of blank leading columns, per spec,
// so its available width is narrower.
function wrapEntryLines(cells, wordBreaks) {
  const lines = [];
  let pos = 0;
  do {
    const continuation = lines.length > 0;
    const width = continuation ? LIST_CHARS_PER_LINE - LIST_CONTINUATION_INDENT_CHARS : LIST_CHARS_PER_LINE;
    const end = chunkEndPosition(cells.length, pos, wordBreaks, width);
    lines.push({ cells: cells.slice(pos, end), continuation });
    pos = end;
  } while (pos < cells.length);
  return lines;
}

// § Street Abbreviation Key — one entry (POI or street) as physical lines.
// prefixCells is always exactly 3 cells: a street's real label (raw NABCC,
// same as the map's own tactile labels -- never run through the current
// Braille Translation setting, so this list's abbreviation column always
// matches what's actually labeled on the map) or 3 blank cells standing in
// for a POI's marker glyph, drawn separately at render time (see
// drawStreetListLineToPixels) since it isn't a braille character at all.
// The name itself IS translated under the current Braille Translation
// setting, via the same translateCurrentCodeWithBreaks the message display
// uses, so continuation wrapping gets real word-boundary information.
function buildStreetListEntryLines(prefixCells, name, marker) {
  const { cells: restCells, wordBreaks: restBreaks } = translateCurrentCodeWithBreaks('--' + name);
  const cells = [...prefixCells, ...restCells];
  const wordBreaks = [0, prefixCells.length, ...restBreaks.map((b) => b + prefixCells.length)];
  const lines = wrapEntryLines(cells, wordBreaks);
  if (marker && lines.length > 0) lines[0].marker = true;
  return lines;
}

// § Street Abbreviation Key — every entry's physical lines, flattened into one
// sequence: POIs first (3 blank prefix cells, marker flagged on each one's
// first line), then streets (their real label as the prefix).
function buildStreetListPhysicalLines(pois, streets) {
  const lines = [];
  for (const poi of pois) {
    lines.push(...buildStreetListEntryLines([0, 0, 0], poi.name, true));
  }
  for (const street of streets) {
    lines.push(...buildStreetListEntryLines(textToNabccCells(street.label), street.name, false));
  }
  return lines;
}

// § Street Abbreviation Key — the three usage-hint lines shown once, at the
// very top of the tactile list only (not the on-screen dialog -- these are
// Dot Pad-specific key instructions, meaningless without a device). Always
// indented 3 columns like a continuation line, rather than embedding
// literal leading spaces in the translated text -- reuses the exact same
// indent mechanism drawStreetListLineToPixels already applies for
// continuation, instead of spending translated cells on blank space. Each
// hint is wrapped independently at the continuation width in case a future
// braille code ever needs more than one physical line for one of these
// (comfortably under it for all three current codes).
function buildStreetListHeaderLines() {
  const hints = ['123 scrolls up', '456 scrolls down', 'All keys exits.'];
  const width = LIST_CHARS_PER_LINE - LIST_CONTINUATION_INDENT_CHARS;
  const lines = [];
  for (const hint of hints) {
    const { cells, wordBreaks } = translateCurrentCodeWithBreaks(hint);
    let pos = 0;
    do {
      const end = chunkEndPosition(cells.length, pos, wordBreaks, width);
      lines.push({ cells: cells.slice(pos, end), continuation: true });
      pos = end;
    } while (pos < cells.length);
  }
  return lines;
}

// § Street Abbreviation Key — groups physical lines into LIST_LINES_PER_PAGE-
// line screens (what dots 4+5+6 / 1+2+3 page between). Always at least one
// page, even if it's empty, so sendStreetListPageToDevice has something to
// render (a blank display) instead of needing its own empty-list check.
function pageStreetListLines(lines) {
  const pages = [];
  for (let i = 0; i < lines.length; i += LIST_LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LIST_LINES_PER_PAGE));
  }
  return pages.length > 0 ? pages : [[]];
}

// § Street Abbreviation Key — an 8-dot cell's dot positions within its own 2
// (dot-column) x 4 (dot-row) cell, decoded from an already-translated cell
// byte (not a character -- see labelCharacterDots for the character/NABCC
// version this parallels). Extends label rendering's 6-dot version with
// dots 7/8 (bottom row), since translated text (capital sign, number sign,
// 8-dot computer braille) routinely uses them, unlike a label's own
// letters/digits/dash.
const LIST_CELL_DOT_BIT_POSITIONS = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]];
function cellDotPositions(byte) {
  const dots = [];
  for (let bit = 0; bit < 8; bit++) {
    if (byte & (1 << bit)) dots.push(LIST_CELL_DOT_BIT_POSITIONS[bit]);
  }
  return dots;
}

// § Street Abbreviation Key — draws one physical line into the pixel buffer at
// its row (rowIndex * LIST_LINE_PITCH_DOTS). A continuation line's cells
// start LIST_CONTINUATION_INDENT_CHARS columns in. A marker line skips
// decoding its first 3 (blank) cells as characters and instead draws the
// real 3x3 POI marker (drawSquarePixels -- the exact same glyph the map
// itself uses) centered in that same 3-character footprint, per explicit
// direction to reuse the actual marker rather than a braille stand-in.
function drawStreetListLineToPixels(pixels, w, h, line, rowIndex, scaleX, scaleY) {
  const rowY = rowIndex * LIST_LINE_PITCH_DOTS;
  const colOffset = line.continuation ? LIST_CONTINUATION_INDENT_CHARS : 0;
  const startCellIndex = line.marker ? 3 : 0;
  if (line.marker) {
    const cx = 3; // centered in the 3-character (8-dot) prefix box, cols 0-7
    const cy = rowY + 1;
    drawSquarePixels(pixels, w, h, Math.round(cx * scaleX), Math.round(cy * scaleY));
  }
  for (let i = startCellIndex; i < line.cells.length; i++) {
    const colX = (colOffset + i) * LIST_CHAR_PITCH_DOTS;
    for (const [dx, dy] of cellDotPositions(line.cells[i])) {
      setGridPixel(pixels, w, h, Math.round((colX + dx) * scaleX), Math.round((rowY + dy) * scaleY));
    }
  }
}

// § Street Abbreviation Key — module state for the tactile side: every
// physical line, paginated, and which page is currently on the device.
// Rebuilt from scratch each time the dialog opens (see openStreetListDialog)
// rather than incrementally maintained, since the underlying map state
// (and thus what's visible) can't change while the dialog is open, per the
// keyboard/Dot Pad guards below.
let streetListPages = [[]];
let streetListPageIndex = 0;

function rasterizeStreetListPage(page, displayW, displayH) {
  const pixels = new Uint8Array(displayW * displayH);
  const scaleX = displayW / DOT_GRID_WIDTH;
  const scaleY = displayH / DOT_GRID_HEIGHT;
  page.forEach((line, rowIndex) => drawStreetListLineToPixels(pixels, displayW, displayH, line, rowIndex, scaleX, scaleY));
  return pixels;
}

function sendStreetListPageToDevice() {
  if (!currentDevice) return;
  const numCols = currentDevice.numberCellColumns;
  const numRows = currentDevice.numberCellRows;
  const pixels = rasterizeStreetListPage(streetListPages[streetListPageIndex] || [], numCols * 2, numRows * 4);
  sendPixelsToDevice(currentDevice, pixels, numCols, numRows);
}

// § Command / hotkey mapping — dots 4+5+6 / 1+2+3 page the Visible Streets
// list forward/back while it's open, reusing the exact same combos (and
// edge-tone-on-no-more-pages behavior) as the message window's own paging.
function showNextStreetListPage() {
  if (streetListPageIndex + 1 < streetListPages.length) {
    streetListPageIndex++;
    sendStreetListPageToDevice();
  } else {
    playEdgeTone();
  }
}
function showPreviousStreetListPage() {
  if (streetListPageIndex > 0) {
    streetListPageIndex--;
    sendStreetListPageToDevice();
  } else {
    playEdgeTone();
  }
}

// § Street Abbreviation Key — builds both the plain on-screen list and the
// paginated tactile version from the same computeVisibleStreetListEntries
// result, so the two can never disagree about what's currently visible.
// Falls back to an explicit "nothing visible" message rather than an empty
// dialog, per Issue #1's explicit ask for graceful handling of that case
// (e.g. cursor-only mode, or a complexity level that hides everything) --
// the tactile side gets an empty (blank) page the same way. The tactile
// side alone also gets the 3 usage-hint lines prepended at the very top,
// even in the nothing-visible case, since they're about navigating this
// view itself, not about what's in it.
function openStreetListDialog() {
  if (streetListDialog.open) return;
  const { pois, streets } = computeVisibleStreetListEntries();
  streetListContent.innerHTML = '';
  if (pois.length === 0 && streets.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'No streets or Pins are currently visible.';
    streetListContent.appendChild(p);
  } else {
    const list = document.createElement('ul');
    for (const poi of pois) {
      const li = document.createElement('li');
      li.textContent = `■--${poi.name}`;
      list.appendChild(li);
    }
    for (const street of streets) {
      const li = document.createElement('li');
      li.textContent = `${street.label}--${street.name}`;
      list.appendChild(li);
    }
    streetListContent.appendChild(list);
  }
  const lines = [...buildStreetListHeaderLines(), ...buildStreetListPhysicalLines(pois, streets)];
  streetListPages = pageStreetListLines(lines);
  streetListPageIndex = 0;
  sendStreetListPageToDevice();
  streetListDialog.showModal();
}

btnStreetListClose.addEventListener('click', () => streetListDialog.close());

// § Street Abbreviation Key — fires on every close path (Close button,
// Escape, or the dots-1-6 combo below), so the map is put back on the
// device exactly once no matter which one the user used, per the "keep the
// map ready to display again when the list is dismissed" requirement.
streetListDialog.addEventListener('close', () => {
  if (currentDevice) sendGraphicToDevice(currentDevice);
});

const FORM_CONTROL_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
function isFormControlFocused() {
  const focused = document.activeElement;
  if (!focused) return false;
  return FORM_CONTROL_TAGS.has(focused.tagName) || focused.getAttribute('role') === 'menuitem';
}

// § Command / hotkey mapping — every hotkey below fires only on the exact
// key combination it's assigned to. Shift is already naturally excluded
// for letter/digit hotkeys (it changes event.key, e.g. 'i' vs 'I'), but
// Ctrl/Alt/Meta don't change event.key at all, so a plain per-key check
// (e.g. labelZoneKeys[event.key]) would otherwise also fire on Ctrl/Alt/
// Meta + that key -- silently swallowing common browser/OS/AT shortcuts
// that happen to share a letter (Ctrl+A "select all", Alt+Left "back",
// etc.). isPlainKey()/isExactModifiers() make the "no extra modifiers
// beyond what's assigned" check explicit and reusable, so any hotkey
// added in the future is scoped the same way by construction rather than
// by remembering to add the check each time.
function isPlainKey(event) {
  return !event.ctrlKey && !event.altKey && !event.metaKey;
}
function isExactModifiers(event, { ctrl = false, alt = false, meta = false, shift = false } = {}) {
  return event.ctrlKey === ctrl && event.altKey === alt && event.metaKey === meta && event.shiftKey === shift;
}

document.addEventListener('keydown', (event) => {
  if (isFormControlFocused()) return;

  // § Street Abbreviation Key — while the dialog is open, every other hotkey
  // is suppressed so the underlying map can't change state out from under
  // the list; Escape still closes it, since that's the browser's own
  // native <dialog> behavior, not something this handler needs to do.
  if (streetListDialog.open) return;

  // Ctrl+arrow pans (and only Ctrl+arrow -- Ctrl+Shift+arrow, Ctrl+Alt+
  // arrow, etc. are left alone); this is checked ahead of the general
  // "no modifiers at all" guard below since it's the one hotkey in this
  // app that's deliberately assigned a modifier.
  const panDirections = { ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east' };
  if (isExactModifiers(event, { ctrl: true }) && panDirections[event.key]) {
    event.preventDefault();
    panMap(panDirections[event.key]);
    return;
  }

  // Every other hotkey below is unmodified -- bail out on any Ctrl/Alt/
  // Meta so those combinations always reach the browser/OS/AT instead.
  if (!isPlainKey(event)) return;

  // § Command / hotkey mapping — label zone toggles work regardless of
  // whether a map is loaded or the Braille Labels dialog is open (the
  // dialog's checkboxes and these hotkeys drive one shared piece of state).
  const labelZoneKeys = { i: 'top', k: 'bottom', j: 'left', l: 'right' };
  if (labelZoneKeys[event.key]) {
    event.preventDefault();
    toggleLabelZone(labelZoneKeys[event.key]);
    return;
  }

  // § Street Abbreviation Key — / opens the dialog regardless of whether a
  // map is loaded yet, same as the label-zone toggles above; with no map
  // it just shows the "nothing visible" fallback rather than doing nothing.
  if (event.key === '/') {
    event.preventDefault();
    openStreetListDialog();
    return;
  }

  // § Help — h or ? opens the Help dialog, regardless of whether a map is
  // loaded yet, same as the label-zone toggles and / above.
  if (event.key === 'h' || event.key === '?') {
    event.preventDefault();
    openHelpDialog();
    return;
  }

  if (!lastBbox) return;

  // § Editing the Map — 1-4 jump straight to the matching Map Complexity
  // level (1 = All streets and pathways, 4 = Major highways), only once a
  // map is loaded (unlike the label-zone hotkeys above, a complexity change
  // has no effect with nothing on screen, and mapComplexityIndex resets on
  // the next new anchor anyway).
  const complexityNum = Number(event.key);
  if (complexityNum >= 1 && complexityNum <= MAP_COMPLEXITY_LEVELS.length && String(complexityNum) === event.key) {
    event.preventDefault();
    setMapComplexity(complexityNum - 1);
    return;
  }

  // § Editing the Map — x steps through the same MAP_COMPLEXITY_LEVELS
  // ladder in decreasing-complexity order (index 0 -> 1 -> 2 -> 3), wrapping
  // back to 0 (All streets and pathways) past the end -- a single command
  // for "simplify one more step" instead of having to know which specific
  // 1-4 level to jump to. Same map-loaded gating as 1-4 above.
  if (event.key === 'x') {
    event.preventDefault();
    setMapComplexity((mapComplexityIndex + 1) % MAP_COMPLEXITY_LEVELS.length);
    return;
  }

  // § Command / hotkey mapping — 0 toggles cursor-only mode on/off.
  if (event.key === '0') {
    event.preventDefault();
    toggleCursorOnlyMode();
    return;
  }

  // § Density metric (experimental) — d prints the current density
  // reading to the message field.
  if (event.key === 'd') {
    event.preventDefault();
    showMapDensity();
    return;
  }

  // § New Map / New Pin / Edit Pin — n opens New Map, always available. p
  // opens New Pin or Edit Pin, whichever applies (documented); a does the
  // same thing but quietly, undocumented -- kept for muscle memory from
  // before this dialog was renamed from "Drop Pin" (see ui-cleanup.md).
  // Both p and a no-op via openCustomPoiDialog's own hasAnchor guard
  // before a first map exists (currentPoi() is null with no map either,
  // so openNewOrEditPinDialog always falls through to it in that case).
  if (event.key === 'n') {
    event.preventDefault();
    openNewMapDialog();
    return;
  }
  if (event.key === 'p' || event.key === 'a') {
    event.preventDefault();
    openNewOrEditPinDialog();
    return;
  }

  // § Additional POIs — . / , navigate forward/back through the POI list,
  // same as dot 4 / dot 1 alone on the Dot Pad (see the key-event callback
  // below).
  if (event.key === '.' || event.key === ',') {
    event.preventDefault();
    navigatePoiList(event.key === '.' ? 1 : -1);
    return;
  }

  // § Command / hotkey mapping — [ increases scale (zoom out), ] decreases
  // (zoom in).
  if (event.key === '[' || event.key === ']') {
    event.preventDefault();
    changeScale(event.key === '[' ? 1 : -1);
    return;
  }

  const cursorDeltas = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1]
  };
  const delta = cursorDeltas[event.key];
  if (!delta) return;
  event.preventDefault();
  moveCursor(delta[0], delta[1]);
});

// ── Dot Pad connection + tactile rendering ──────────────────────────────────
// Reuses the DotSVG project's braille-message and pixel-rasterization modules
// (see tmap spec.md § Representing braille on the Dot Pad) rather than
// reinventing them.

// NABCC 8-dot Computer Braille lookup table, ported verbatim from DotSVG.
// Index = ASCII code - 0x20 (covers 0x20 space through 0x7E tilde).
// Value = 8-dot braille byte: bit0=dot1, bit1=dot2, ..., bit7=dot8.
// Source: BRLTTY en-nabcc.ttb (North American Braille Computer Code)
const NABCC = new Uint8Array([
  0x00, 0x2E, 0x10, 0x3C, 0x2B, 0x29, 0x2F, 0x04, 0x37, 0x3E, 0x21, 0x2C, 0x20, 0x24, 0x28, 0x0C,
  0x34, 0x02, 0x06, 0x12, 0x32, 0x22, 0x16, 0x36, 0x26, 0x14, 0x31, 0x30, 0x23, 0x3F, 0x1C, 0x39,
  0x48, 0x41, 0x43, 0x49, 0x59, 0x51, 0x4B, 0x5B, 0x53, 0x4A, 0x5A, 0x45, 0x47, 0x4D, 0x5D, 0x55,
  0x4F, 0x5F, 0x57, 0x4E, 0x5E, 0x65, 0x67, 0x7A, 0x6D, 0x7D, 0x75, 0x6A, 0x73, 0x7B, 0x58, 0x38,
  0x08, 0x01, 0x03, 0x09, 0x19, 0x11, 0x0B, 0x1B, 0x13, 0x0A, 0x1A, 0x05, 0x07, 0x0D, 0x1D, 0x15,
  0x0F, 0x1F, 0x17, 0x0E, 0x1E, 0x25, 0x27, 0x3A, 0x2D, 0x3D, 0x35, 0x2A, 0x33, 0x3B, 0x18
]);

// § Settings / § Braille translator — raw NABCC byte per character, no
// padding/truncation (that's cellsToMessageHex's job, downstream --
// see translateCurrentCodeWithBreaks, which calls this per space-
// delimited segment as the "computer8" case alongside
// translateGrade1/translateGrade2). Street labels use NABCC directly
// via labelCharacterDots further up the render pipeline, never this.
function textToNabccCells(text) {
  const cells = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    cells.push((code >= 0x20 && code <= 0x7E) ? NABCC[code - 0x20] : 0x00);
  }
  return cells;
}

// § Settings / § Braille translator — pads/truncates an array of
// already-computed 6-dot cell bitmasks (or NABCC bytes, for the
// computer8 case -- either way, one byte per cell) to exactly numCells,
// hex-encoding each as displayTextData expects.
function cellsToMessageHex(cells, numCells) {
  let hex = '';
  for (let i = 0; i < numCells; i++) {
    const mask = i < cells.length ? cells[i] : 0;
    hex += mask.toString(16).padStart(2, '0').toUpperCase();
  }
  return hex;
}

// Bresenham line/circle rasterization directly into a dot-grid pixel buffer,
// ported from DotSVG. Drawing at native tactile resolution (rather than
// downscaling a full-size SVG image) guarantees every touched pixel is fully
// on, so thin street lines can't anti-alias away to nothing at 60x40.
function setGridPixel(pixels, w, h, x, y) {
  if (x >= 0 && x < w && y >= 0 && y < h) pixels[y * w + x] = 1;
}

function drawLinePixels(pixels, w, h, x0, y0, x1, y1) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x1 > x0 ? 1 : -1, sy = y1 > y0 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (true) {
    setGridPixel(pixels, w, h, x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

// § Braille labels — Liang-Barsky segment-vs-rectangle clip. Needed because
// way geometry routinely extends well beyond the current viewport (see
// rasterizeMapToPixels), so a raw Bresenham draw would run straight through
// a reserved label zone on its way to an off-screen endpoint. Returns null
// if the segment doesn't intersect the rect at all.
function clipSegmentToRect(x0, y0, x1, y1, minX, minY, maxX, maxY) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const edges = [
    [-dx, x0 - minX],
    [dx, maxX - x0],
    [-dy, y0 - minY],
    [dy, maxY - y0]
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return {
    x0: x0 + t0 * dx, y0: y0 + t0 * dy,
    x1: x0 + t1 * dx, y1: y0 + t1 * dy
  };
}

// § SVG Display Requirements — cursor is "a 4x4 square with corner dots
// removed": an 8-dot ring around a 2x2 unfilled center. (cx,cy) is the
// square's upper-left interior corner.
function drawCursorPixels(pixels, w, h, cx, cy) {
  cx = Math.round(cx); cy = Math.round(cy);
  const offsets = [
    [0, -1], [1, -1],
    [-1, 0], [2, 0],
    [-1, 1], [2, 1],
    [0, 2], [1, 2]
  ];
  for (const [dx, dy] of offsets) {
    setGridPixel(pixels, w, h, cx + dx, cy + dy);
  }
}

// § POIs — a solid 3x3 dot square, all corners filled, for every POI
// marker (anchor and additional alike) -- clearly distinct from the
// cursor's hollow ring, and more prominent than a single dot.
function drawSquarePixels(pixels, w, h, cx, cy) {
  cx = Math.round(cx); cy = Math.round(cy);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      setGridPixel(pixels, w, h, cx + dx, cy + dy);
    }
  }
}

// Packs a 0/1 pixel buffer into the DotPad SDK's per-cell hex byte format
// (each braille cell is 2 dots wide x 4 dots tall).
function packPixelsToHex(pixels, displayW, displayH, numRows) {
  const nibbles = new Uint8Array(displayW * numRows);
  for (let y = 0; y < displayH; y++) {
    const band = Math.floor(y / 4);
    const bit = y % 4;
    for (let x = 0; x < displayW; x++) {
      if (pixels[y * displayW + x]) {
        nibbles[(x ^ 1) + band * displayW] |= (1 << bit);
      }
    }
  }
  // No padStart here: each entry is a true 4-bit nibble (bit ranges 0-3, so
  // the max value is 0b1111 = 0xF) and needs exactly one hex character, not
  // two. Padding to 2 chars (as the message-line byte encoding correctly
  // does) silently doubles the string length and shifts every nibble after
  // the first non-trivial one out of alignment -- this was the actual bug
  // behind the deformed grid, not any timing/delay issue.
  return Array.from(nibbles, (n) => n.toString(16).toUpperCase()).join('');
}

// Reprojects lon/lat directly to the device's native dot-grid resolution
// (not downscaled from the on-screen 600x400 SVG) and rasterizes streets +
// anchor marker with the Bresenham helpers above. `ways` is whatever
// visibleWays() passed in (see sendGraphicToDevice) -- every street/pathway
// Overpass returned, minus anything hidden via the Edit Map dialog.
function rasterizeMapToPixels(bbox, ways, anchorLat, anchorLon, displayW, displayH, cursor) {
  const pixels = new Uint8Array(displayW * displayH);
  // § Braille labels — project into the device-pixel sub-rect matching
  // mapGridBounds (scaled from dot units to this device's own reported
  // resolution, same as the cursor scaling below). Segments are clipped to
  // this rect below (see clipSegmentToRect) so a reserved zone actually
  // stays blank, rather than just being where in-bounds points happen to
  // land.
  const b = mapGridBounds();
  const scaleX = displayW / DOT_GRID_WIDTH;
  const scaleY = displayH / DOT_GRID_HEIGHT;
  const rectX = b.offsetX * scaleX;
  const rectY = b.offsetY * scaleY;
  const rectW = b.width * scaleX;
  const rectH = b.height * scaleY;
  // -0.5 matches DotSVG's pixX/pixY: canvas/logical coordinates address the
  // *center* of a display pixel, not its corner (see rasterizeShapes).
  const project = (lat, lon) => ({
    x: rectX + ((lon - bbox.west) / (bbox.east - bbox.west)) * rectW - 0.5,
    y: rectY + ((bbox.north - lat) / (bbox.north - bbox.south)) * rectH - 0.5
  });

  // § Braille labels — way geometry commonly extends well beyond the
  // current viewport (lastBbox is the whole fetched square; bbox here is
  // just the visible window within it), so each segment is clipped to the
  // map rect before drawing rather than relying on setGridPixel's full-
  // canvas bounds check, which would otherwise let a line run straight
  // through a reserved zone on its way to an off-screen endpoint.
  const rectMaxX = rectX + rectW;
  const rectMaxY = rectY + rectH;
  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    let prev = null;
    for (const pt of way.geometry) {
      const p = project(pt.lat, pt.lon);
      if (prev) {
        const clipped = clipSegmentToRect(prev.x, prev.y, p.x, p.y, rectX, rectY, rectMaxX, rectMaxY);
        if (clipped) drawLinePixels(pixels, displayW, displayH, clipped.x0, clipped.y0, clipped.x1, clipped.y1);
      }
      prev = p;
    }
  }

  // § Editing the Map — a POI unchecked in the Edit Map dialog is skipped
  // here, same as on the on-screen SVG (see renderStreetsAndAnchor).
  // § Command / hotkey mapping — also skipped entirely while cursorOnlyMode
  // is active, same as that function.
  const anchor = project(anchorLat, anchorLon);
  if (!cursorOnlyMode && !hiddenPoiNames.has(lastAnchorName) &&
      anchor.x >= rectX && anchor.x <= rectMaxX && anchor.y >= rectY && anchor.y <= rectMaxY) {
    drawSquarePixels(pixels, displayW, displayH, anchor.x, anchor.y);
  }

  for (const poi of additionalPois) {
    if (cursorOnlyMode || hiddenPoiNames.has(poi.name)) continue;
    const p = project(poi.lat, poi.lon);
    if (p.x >= rectX && p.x <= rectMaxX && p.y >= rectY && p.y <= rectMaxY) {
      drawSquarePixels(pixels, displayW, displayH, p.x, p.y);
    }
  }

  if (cursor) {
    // cursor.x/y are map-relative grid units (see cursorGridPosition), so
    // scale the same way as street projection above, then offset into the
    // device-pixel sub-rect. Clamped so the full 8-dot ring (offsets -1..+2,
    // see drawCursorPixels) always fits within the map region rather than
    // getting dots silently dropped by setGridPixel's own bounds check, or
    // spilling into an adjacent label zone.
    const cx = clamp(rectX + cursor.x * scaleX, rectX + 1, rectX + rectW - 3);
    const cy = clamp(rectY + cursor.y * scaleY, rectY + 1, rectY + rectH - 3);
    drawCursorPixels(pixels, displayW, displayH, cx, cy);
  }

  drawLabelDotsToPixels(pixels, displayW, displayH, computeLabelPlacements(), b, scaleX, scaleY);

  return pixels;
}

// Diagnostic-only: a 6x4 lattice of long horizontal and vertical lines
// spanning the full display, drawn with the exact same drawLinePixels /
// packPixelsToHex path as real street data. Shown before the first map is
// loaded so a broken/discontinuous render can be isolated to the rendering
// pipeline itself (grid also broken) vs. something specific to street
// geometry (grid solid, map broken).
function rasterizeTestGrid(displayW, displayH, cols, rows) {
  const pixels = new Uint8Array(displayW * displayH);
  for (let c = 0; c <= cols; c++) {
    const x = Math.min(displayW - 1, Math.round((c / cols) * (displayW - 1)));
    drawLinePixels(pixels, displayW, displayH, x, 0, x, displayH - 1);
  }
  for (let r = 0; r <= rows; r++) {
    const y = Math.min(displayH - 1, Math.round((r / rows) * (displayH - 1)));
    drawLinePixels(pixels, displayW, displayH, 0, y, displayW - 1, y);
  }
  return pixels;
}

function sendPixelsToDevice(device, pixels, numCols, numRows, { skipClear = false } = {}) {
  const displayW = numCols * 2;
  const displayH = numRows * 4;
  const hex = packPixelsToHex(pixels, displayW, displayH, numRows);
  // § Cursor and hit testing — the clear pass is skipped for coalesced
  // cursor-move sends (see scheduleCursorGraphicSend): a full frame is
  // already a complete description of the desired state, so writing all
  // zeros first is pure waste there. Left as the default for every other
  // caller (pan/scale/label-toggle/edit redraws, the initial connect-time
  // grid), which isn't part of this change.
  if (!skipClear) {
    const zeros = '00'.repeat(numCols * numRows);
    sdk.displayGraphicData(zeros, device, DisplayMode.GraphicMode);
  }
  sdk.displayGraphicData(hex, device, DisplayMode.GraphicMode);
}

function sendGraphicToDevice(device, { skipClear = false } = {}) {
  const viewportBbox = getViewportBbox();
  if (!viewportBbox) return;
  const numCols = device.numberCellColumns;
  const numRows = device.numberCellRows;
  const displayW = numCols * 2;
  const displayH = numRows * 4;
  const cursor = cursorGridPosition(viewportBbox);
  const pixels = rasterizeMapToPixels(viewportBbox, visibleWays(), lastAnchorLat, lastAnchorLon, displayW, displayH, cursor);
  sendPixelsToDevice(device, pixels, numCols, numRows, { skipClear });
}

// § Density metric (experimental) — the percentage of "raised" pixels
// within the map's own drawable region (mapGridBounds -- the same
// effective area the tactile map itself draws into, which shrinks when a
// label zone is active) out of every pixel in that region. Reuses the
// exact same rasterization the tactile display already sends
// (rasterizeMapToPixels) at the fixed DOT_GRID_WIDTH/HEIGHT logical
// resolution (independent of any connected device's own reported
// resolution, since this describes the current map view, not a specific
// device), then sums only within mapGridBounds' own rectangle -- an active
// label zone's pixels live entirely outside that rectangle by
// construction, so they're excluded without needing a separate
// labels-free rasterization path. Counts everything the rasterizer draws
// there: streets, the anchor, every POI, and the cursor -- not just
// streets, per explicit direction, so this really is "every map pixel
// that isn't a label," not a street-only metric. This is purely a
// real-time inspection tool for comparing candidate density metrics
// (see Issue discussion) -- nothing here drives any automatic
// simplification.
// § Auto Simplification — the optional complexityIndex parameter lets
// resolveAutoComplexityIndex evaluate a hypothetical level's density
// (before committing to it) without touching the real mapComplexityIndex;
// the d hotkey's own call omits it and gets today's behavior unchanged.
function computeMapDensityPercent(complexityIndex = mapComplexityIndex) {
  const viewportBbox = getViewportBbox();
  if (!viewportBbox) return null;
  const b = mapGridBounds();
  const cursor = cursorGridPosition(viewportBbox);
  const pixels = rasterizeMapToPixels(viewportBbox, visibleWays(complexityIndex), lastAnchorLat, lastAnchorLon, DOT_GRID_WIDTH, DOT_GRID_HEIGHT, cursor);
  let raised = 0;
  for (let y = b.offsetY; y < b.offsetY + b.height; y++) {
    for (let x = b.offsetX; x < b.offsetX + b.width; x++) {
      if (pixels[y * DOT_GRID_WIDTH + x]) raised++;
    }
  }
  const total = b.width * b.height;
  return total > 0 ? Math.round(100 * raised / total) : 0;
}

// § Density metric (experimental) — d prints the current density to the
// message field, same as any other message (overwrites whatever was there
// before, per standard message-display behavior). No-op with no map
// loaded, same as computeMapDensityPercent's own guard.
function showMapDensity() {
  const percent = computeMapDensityPercent();
  if (percent === null) return;
  setMessage(`Density: ${percent}%`);
}

function sendTestGridToDevice(device) {
  const numCols = device.numberCellColumns;
  const numRows = device.numberCellRows;
  const displayW = numCols * 2;
  const displayH = numRows * 4;
  const pixels = rasterizeTestGrid(displayW, displayH, 6, 4);
  sendPixelsToDevice(device, pixels, numCols, numRows);
}

// § Screen Layout — Connect Dot Pad lives on the main screen and is only
// shown while disconnected; Disconnect Dot Pad lives at the bottom of the
// Main Menu and only exists there while connected (see main-menu.disconnect
// item's hidden toggling below) -- the two are never both present at once.
function setConnectedState(device) {
  currentDevice = device;
  btnConnect.hidden = true;
  btnDisconnect.hidden = false;
  // Graphic renders immediately (matches DotSVG); the message-line write is
  // delayed 1s -- confirmed by testing this avoids a ~15s hold-up before the
  // graphic write completes, so it stays even though the actual deformed-grid
  // bug (packPixelsToHex padding above) is now fixed for other reasons.
  if (lastBbox) {
    setMessage('Connected', 1000);
    sendGraphicToDevice(device);
  } else {
    setMessage('Connected: grid', 1000);
    sendTestGridToDevice(device);
  }
}

function setDisconnectedState() {
  currentDevice = null;
  btnConnect.hidden = false;
  btnDisconnect.hidden = true;
  setMessage('Disconnected');
}

btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true;
  setMessage('Scanning…');
  try {
    const bleDevice = await scanner.startBleScan();
    if (!bleDevice) {
      setMessage('No device selected');
      btnConnect.disabled = false;
      return;
    }
    setMessage('Connecting…');
    const dotDevice = await sdk.connectBleDevice(bleDevice);
    if (!dotDevice) {
      setMessage('Connect failed');
      btnConnect.disabled = false;
    }
  } catch (err) {
    setMessage('Connect error');
    btnConnect.disabled = false;
  }
});

btnDisconnect.addEventListener('click', () => {
  closeMainMenu({ focusButton: true });
  if (currentDevice) sdk.disconnect(currentDevice);
});

// The key-event callback is a placeholder for now — cursor movement/hit-testing
// (Phase 1 item 4) and hotkey wiring (item 5) aren't built yet.
// § Command / hotkey mapping — decodes a Dot Pad key event into a byte6
// dot-chord bitmask, ported verbatim from DotSVG's labelToByte6. Cursor
// dots per tmap spec.md § Cursor and hit testing: 3=left, 2=up, 5=down,
// 6=right (bit0=dot1 ... bit5=dot6).
function labelToByte6(label) {
  const hasLP = /\bLP\b/.test(label) || /\bAP\b/.test(label);
  const hasRP = /\bRP\b/.test(label) || /\bAP\b/.test(label);
  const mPlus = label.match(/\+\s*(\d+)/);
  const mBare = !mPlus && label.match(/^\d+$/);
  const num = mPlus ? parseInt(mPlus[1], 10) : mBare ? parseInt(mBare[0], 10) : 0;
  return ((num & 4) ? 0x01 : 0) |  // dot 1
         ((num & 8) ? 0x02 : 0) |  // dot 2
         (hasLP     ? 0x04 : 0) |  // dot 3
         ((num & 2) ? 0x08 : 0) |  // dot 4
         ((num & 1) ? 0x10 : 0) |  // dot 5
         (hasRP     ? 0x20 : 0);   // dot 6
}

sdk.setCallBack(
  (device, dataCode) => {
    btnConnect.disabled = false;
    if (dataCode === DataCodes.Connected) {
      setConnectedState(device);
    } else if (dataCode === DataCodes.Disconnected) {
      setDisconnectedState();
    } else if (dataCode === DataCodes.ConnectedFail) {
      setMessage('Connect failed');
    }
  },
  (device, keyCode, msg) => {
    const byte6 = labelToByte6(msg || keyCode);
    // § Street Abbreviation Key — while the dialog is open, dots 4+5+6 / 1+2+3
    // page the list (reusing the message window's own combos -- see
    // showNextStreetListPage/showPreviousStreetListPage) and dots 1+2+3+4+
    // 5+6 close it; every other Dot Pad combo is suppressed, same reasoning
    // as the keyboard guard above.
    if (streetListDialog.open) {
      if (byte6 === 0x3F) streetListDialog.close();
      else if (byte6 === 0x38) showNextStreetListPage();
      else if (byte6 === 0x07) showPreviousStreetListPage();
      return;
    }
    // § Command / hotkey mapping — cursor: single dots 3/2/5/6.
    if (byte6 === 0x04) moveCursor(-1, 0);       // dot3 alone -> left
    else if (byte6 === 0x20) moveCursor(1, 0);   // dot6 alone -> right
    else if (byte6 === 0x02) moveCursor(0, -1);  // dot2 alone -> up
    else if (byte6 === 0x10) moveCursor(0, 1);   // dot5 alone -> down
    // Pan: two-dot combos.
    else if (byte6 === 0x09) panMap('north');    // dots 1+4
    else if (byte6 === 0x24) panMap('south');    // dots 3+6
    else if (byte6 === 0x05) panMap('west');     // dots 1+3
    else if (byte6 === 0x28) panMap('east');     // dots 4+6
    // Scale: two-dot combos.
    else if (byte6 === 0x06) changeScale(1);     // dots 2+3 -> increase (zoom out)
    else if (byte6 === 0x30) changeScale(-1);    // dots 5+6 -> decrease (zoom in)
    // § Braille labels — label zone toggles, matching the braille-cell dot
    // pattern of u/m/w/r (the same top/bottom/left/right assignment as the
    // i/j/k/l keyboard hotkeys, see labelZoneKeys above). Works regardless
    // of whether a map is loaded, same as the keyboard hotkeys, since
    // toggleLabelZone/setLabelZone don't depend on one.
    else if (byte6 === 0x25) toggleLabelZone('top');     // dots 1+3+6 (u)
    else if (byte6 === 0x0D) toggleLabelZone('bottom');  // dots 1+3+4 (m)
    else if (byte6 === 0x3A) toggleLabelZone('left');    // dots 2+4+5+6 (w)
    else if (byte6 === 0x17) toggleLabelZone('right');   // dots 1+2+3+5 (r)
    // § Editing the Map — x's own braille cell steps through Map Complexity,
    // same as the x keyboard hotkey (see the keydown handler).
    else if (byte6 === 0x2D) setMapComplexity((mapComplexityIndex + 1) % MAP_COMPLEXITY_LEVELS.length); // dots 1+3+4+6 (x)
    // § Command / hotkey mapping — dots 3+5+6 toggle cursor-only mode, same
    // as the 0 keyboard hotkey.
    else if (byte6 === 0x34) toggleCursorOnlyMode(); // dots 3+5+6
    // § Density metric (experimental) — d's own braille cell (dots 1+4+5),
    // same convention as u/m/w/r/x above, same as the d keyboard hotkey.
    else if (byte6 === 0x19) showMapDensity(); // dots 1+4+5 (d)
    // § Additional POIs — single dots 4/1, same as ./, on the keyboard.
    else if (byte6 === 0x08) navigatePoiList(1);   // dot4 alone -> next POI
    else if (byte6 === 0x01) navigatePoiList(-1);  // dot1 alone -> previous POI
    // § Message display architecture — dots 4+5+6 / 1+2+3 page the
    // virtual message window forward/back.
    else if (byte6 === 0x38) showNextMessageChunk();      // dots 4+5+6
    else if (byte6 === 0x07) showPreviousMessageChunk();  // dots 1+2+3
    // § Street Abbreviation Key — dots 3+4 open the dialog, same as / on the
    // keyboard.
    else if (byte6 === 0x0C) openStreetListDialog();      // dots 3+4
  }
);

// § My Archives — restore the current map from local storage on startup,
// if one exists, so a page reload doesn't lose an in-progress map. Uses
// the same restore path as loading a Recent/Saved Maps entry, but first
// checks the local ways cache (see loadCurrentMapWaysLocally) -- a hit
// skips Overpass entirely; a miss (or a corrupted/unavailable cache) falls
// through to loadMapRecord's normal live fetch, exactly as before this
// cache existed.
const persistedCurrentMap = loadPersistedCurrentMap();
if (persistedCurrentMap) {
  loadCurrentMapWaysLocally().then((cachedWays) => loadMapRecord(persistedCurrentMap, cachedWays || undefined));
}
