const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const POSTPASS_URL = 'https://postpass.geofabrik.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const REVERSE_GEOCODE_DELAY_MS = 1100; // stay under Nominatim's ~1 req/sec usage policy

const MILES_TO_METERS = 1609.344;
const HALF_WIDTH_METERS = 0.3 * MILES_TO_METERS; // east/west of the target address
const HALF_HEIGHT_METERS = 0.2 * MILES_TO_METERS; // north/south of the target address

const SVG_WIDTH = 600; // matches DotSVG's 600x400 canvas (10:1 over the 60x40 dot grid)
const SVG_HEIGHT = 400;

const ROADWAY_HIGHWAY_VALUES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service'
]);
const PEDESTRIAN_HIGHWAY_VALUES = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'steps']);

const form = document.getElementById('search-form');
const input = document.getElementById('location-input');
const statusMessage = document.getElementById('status-message');
const matchedLocation = document.getElementById('matched-location');
const streetList = document.getElementById('street-list');
const viewMenuButton = document.getElementById('view-menu-button');
const viewMenu = document.getElementById('view-menu');
const viewMenuItems = Array.from(viewMenu.querySelectorAll('[role="menuitemradio"]'));
const copySvgBtn = document.getElementById('copy-svg-btn');
const copySvgStatus = document.getElementById('copy-svg-status');
const dataSourceFieldset = document.getElementById('data-source-fieldset');
const dataSourceRadios = Array.from(dataSourceFieldset.querySelectorAll('input[name="data-source"]'));
const viewHeading = document.getElementById('view-heading');

// Display label for each view, taken straight from the menu button's own
// text so it can't drift out of sync with what the menu actually shows.
const VIEW_LABELS = {};
viewMenuItems.forEach((item) => { VIEW_LABELS[item.dataset.view] = item.textContent.trim(); });

let lastWays = [];
let lastBbox = null;
let currentView = 'overview';

function updateViewHeading() {
  viewHeading.textContent = VIEW_LABELS[currentView] || '';
}
updateViewHeading();

// § Data source switch — Postpass/Overpass, ported from tmapdev's own
// DATA_SOURCE toggle (see postpass-migration-spec.md). Persisted so the
// choice survives a page reload, same pattern tmap itself uses for user
// settings. Selecting a source only takes effect on the next search --
// it never re-fetches whatever's already on screen.
const DATA_SOURCE_STORAGE_KEY = 'osmDataMine.dataSource';
let dataSource = localStorage.getItem(DATA_SOURCE_STORAGE_KEY) || 'postpass';
if (!dataSourceRadios.some((r) => r.value === dataSource)) dataSource = 'postpass';
dataSourceRadios.forEach((radio) => {
  radio.checked = radio.value === dataSource;
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    dataSource = radio.value;
    localStorage.setItem(DATA_SOURCE_STORAGE_KEY, dataSource);
  });
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (query) {
    runSearch(query);
  }
});

// § Layout experiment — accessible menu button (WAI-ARIA "Actions Menu
// Button" pattern) replacing what used to be a radio-button fieldset in the
// footer. Menu items are menuitemradio (not plain menuitem) since exactly
// one view is always "current" and both a screen reader (via aria-checked)
// and sighted users (via the CSS checkmark on [aria-checked="true"]) need
// to be able to tell which one that is.
function openViewMenu(focusIndex) {
  viewMenu.hidden = false;
  viewMenuButton.setAttribute('aria-expanded', 'true');
  focusViewMenuItem(focusIndex);
}

function closeViewMenu({ focusButton = false } = {}) {
  if (viewMenu.hidden) return;
  viewMenu.hidden = true;
  viewMenuButton.setAttribute('aria-expanded', 'false');
  if (focusButton) viewMenuButton.focus();
}

// Roving tabindex: only the item DOM focus currently sits on is reachable
// via Tab; arrow keys move both the tabindex and actual focus together.
function focusViewMenuItem(index) {
  viewMenuItems.forEach((item, i) => item.setAttribute('tabindex', i === index ? '0' : '-1'));
  viewMenuItems[index].focus();
}

viewMenuButton.addEventListener('click', () => {
  if (viewMenu.hidden) {
    openViewMenu(0);
  } else {
    closeViewMenu();
  }
});

viewMenuButton.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openViewMenu(0);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    openViewMenu(viewMenuItems.length - 1);
  }
});

viewMenuItems.forEach((item, index) => {
  item.addEventListener('click', () => {
    currentView = item.dataset.view;
    viewMenuItems.forEach((mi) => mi.setAttribute('aria-checked', mi === item ? 'true' : 'false'));
    updateViewHeading();
    closeViewMenu({ focusButton: true });
    if (currentView === 'all-types') {
      if (lastBbox) loadAndRenderAllTypes();
    } else if (lastWays.length) {
      renderResults(lastWays);
    }
  });

  item.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusViewMenuItem((index + 1) % viewMenuItems.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusViewMenuItem((index - 1 + viewMenuItems.length) % viewMenuItems.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusViewMenuItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusViewMenuItem(viewMenuItems.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeViewMenu({ focusButton: true });
    } else if (event.key === 'Tab') {
      closeViewMenu();
    }
  });
});

document.addEventListener('click', (event) => {
  if (!viewMenu.hidden && !event.target.closest('#view-menu-container')) {
    closeViewMenu();
  }
});

copySvgBtn.addEventListener('click', async () => {
  if (!lastWays.length || !lastBbox) {
    copySvgStatus.textContent = 'No street data to copy yet -- run a search first.';
    return;
  }

  const svgText = buildSvgDocument(lastWays, lastBbox);
  try {
    await navigator.clipboard.writeText(svgText);
    copySvgStatus.textContent = 'SVG copied to clipboard.';
  } catch (err) {
    copySvgStatus.textContent = 'Could not copy SVG to clipboard.';
  }
});

async function runSearch(query) {
  clearResults();
  setStatus(`Searching for "${query}"...`);

  let place;
  try {
    place = await geocode(query);
  } catch (err) {
    setStatus('There was a problem looking up that location. Please try again.');
    return;
  }

  if (!place) {
    setStatus(`No location found for "${query}". Try a more specific search.`);
    return;
  }

  matchedLocation.textContent = `Matched location: ${formatMatchedLocation(place)}`;

  let ways;
  try {
    const bbox = boundingBox(parseFloat(place.lat), parseFloat(place.lon));
    lastBbox = bbox;
    ways = await fetchWays(bbox);
  } catch (err) {
    setStatus('There was a problem retrieving street data from OpenStreetMap. Please try again.');
    return;
  }

  if (ways.length === 0) {
    setStatus('No named streets found within this area.');
    return;
  }

  setStatus('');
  renderResults(ways);
}

function boundingBox(lat, lon) {
  const metersPerDegreeLat = 111320;
  const latDelta = HALF_HEIGHT_METERS / metersPerDegreeLat;
  const lonDelta = HALF_WIDTH_METERS / (metersPerDegreeLat * Math.cos((lat * Math.PI) / 180));
  return {
    south: lat - latDelta,
    north: lat + latDelta,
    west: lon - lonDelta,
    east: lon + lonDelta
  };
}

async function geocode(query) {
  const url = `${NOMINATIM_URL}?format=json&q=${encodeURIComponent(query)}&limit=1&addressdetails=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('geocode-failed');
  const data = await res.json();
  return data.length ? data[0] : null;
}

function formatMatchedLocation(place) {
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

async function fetchWays(bbox) {
  return dataSource === 'postpass' ? fetchWaysFromPostpass(bbox) : fetchWaysFromOverpass(bbox);
}

async function fetchWaysFromOverpass(bbox) {
  const query = `[out:json][timeout:25];way["highway"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out geom;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error('overpass-failed');
  const data = await res.json();
  return data.elements || [];
}

// Ported from tmapdev's own buildPostpassQuery/adaptPostpassResponse (see
// postpass-migration-spec.md) without the production retry/backoff/
// analytics-logging machinery -- this is a data-exploration sandbox, not
// the live app, so a single attempt is enough. Deliberately mirrors the
// Overpass query above exactly (name required, no issue #19 ref rescue)
// so the two sources stay directly comparable here.
function buildPostpassWaysQuery(bbox) {
  return `SELECT osm_id, geom, tags FROM postpass_line WHERE geom && ST_MakeEnvelope(${bbox.west},${bbox.south},${bbox.east},${bbox.north},4326) AND tags?'highway' AND tags?'name'`;
}

async function fetchWaysFromPostpass(bbox) {
  const query = buildPostpassWaysQuery(bbox);
  const res = await fetch(POSTPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error('postpass-failed');
  const data = await res.json();
  if (data.type !== 'FeatureCollection') throw new Error('postpass-unexpected-response');
  return data.features.map((f) => ({
    type: 'way',
    id: f.properties.osm_id,
    tags: f.properties.tags || {},
    geometry: flattenMultiLineString(f.geometry)
  }));
}

// Postpass packages line geometry as MultiLineString even for a normal,
// unsplit way -- tmapdev's own migration sampled 2,601 real ways across 7
// areas and found this is just Postpass's packaging convention, never an
// actually-split way (see postpass-migration-spec.md §4.2). Takes the
// first part; warns rather than silently mishandling it if that's ever
// wrong.
function flattenMultiLineString(geometry) {
  if (geometry.coordinates.length > 1) {
    console.warn('Postpass returned a multi-part MultiLineString', geometry);
  }
  return geometry.coordinates[0].map(([lon, lat]) => ({ lat, lon }));
}

// § All types — a second, much broader fetch than fetchWays()'s
// name+highway-only query: every tagged node/way/relation in the bbox,
// regardless of type. Loaded lazily (only when the "All types" view is
// actually selected, see loadAndRenderAllTypes below) since it returns
// far more data than the street-only views need.

async function fetchAllTypes(bbox) {
  return dataSource === 'postpass' ? fetchAllTypesFromPostpass(bbox) : fetchAllTypesFromOverpass(bbox);
}

// `[~"."~"."]` is the standard Overpass QL idiom for "has at least one
// tag" (key matches the any-character regex "." AND value matches "."),
// i.e. excludes bare geometry-only nodes (way vertices) that carry no
// tags of their own.
async function fetchAllTypesFromOverpass(bbox) {
  const bboxArgs = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const query = `[out:json][timeout:25];(node[~"."~"."](${bboxArgs});way[~"."~"."](${bboxArgs});relation[~"."~"."](${bboxArgs}););out geom;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error('overpass-failed');
  const data = await res.json();
  return (data.elements || []).map((el) => ({
    type: el.type,
    id: el.id,
    tags: el.tags || {},
    geometryKind: classifyOverpassGeometryKind(el)
  }));
}

// Overpass doesn't label geometry kind directly -- derive it: a node is
// always a point; a way is a shape (area) if its geometry is a closed ring
// (first/last point coincide, OSM's own convention for "this line encloses
// an area") and a line otherwise; a relation is classified by its own
// `type` tag (multipolygon/boundary relations are areas, route relations
// are lines), falling back to a plain "relation" label for anything else
// rather than guessing wrong.
function classifyOverpassGeometryKind(el) {
  if (el.type === 'node') return 'point';
  if (el.type === 'way') {
    const geom = el.geometry || [];
    const first = geom[0];
    const last = geom[geom.length - 1];
    if (geom.length >= 4 && first && last && first.lat === last.lat && first.lon === last.lon) {
      return 'shape';
    }
    return 'line';
  }
  if (el.type === 'relation') {
    const relType = el.tags && el.tags.type;
    if (relType === 'multipolygon' || relType === 'boundary') return 'shape';
    if (relType === 'route') return 'line';
    return 'relation';
  }
  return 'unknown';
}

// postpass_pointlinepolygon is Postpass's combined view over its point/
// line/polygon tables (see SCHEMA.md) -- one query covers every geometry
// kind instead of three separate ones. `tags <> '{}'::jsonb` is the
// Postpass-side equivalent of Overpass's `[~"."~"."]` any-tag filter.
function buildPostpassAllTypesQuery(bbox) {
  return `SELECT osm_type, osm_id, tags, geom FROM postpass_pointlinepolygon WHERE geom && ST_MakeEnvelope(${bbox.west},${bbox.south},${bbox.east},${bbox.north},4326) AND tags <> '{}'::jsonb`;
}

async function fetchAllTypesFromPostpass(bbox) {
  const query = buildPostpassAllTypesQuery(bbox);
  const res = await fetch(POSTPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error('postpass-failed');
  const data = await res.json();
  if (data.type !== 'FeatureCollection') throw new Error('postpass-unexpected-response');
  return data.features.map((f) => ({
    type: osmTypeToElementType(f.properties.osm_type),
    id: f.properties.osm_id,
    tags: f.properties.tags || {},
    geometryKind: classifyPostpassGeometryKind(f.geometry && f.geometry.type)
  }));
}

function osmTypeToElementType(osmType) {
  if (osmType === 'N') return 'node';
  if (osmType === 'W') return 'way';
  if (osmType === 'R') return 'relation';
  return 'unknown';
}

// Postpass's combined view reports real GeoJSON geometry types directly
// (it comes from three separate point/line/polygon tables under the
// hood), so this is a straight lookup rather than the inference Overpass
// needs.
function classifyPostpassGeometryKind(geoJsonType) {
  if (geoJsonType === 'Point') return 'point';
  if (geoJsonType === 'LineString' || geoJsonType === 'MultiLineString') return 'line';
  if (geoJsonType === 'Polygon' || geoJsonType === 'MultiPolygon') return 'shape';
  return 'unknown';
}

// The standard OSM "Map Features" top-level keys (wiki.openstreetmap.org/
// wiki/Map_features) -- the raw tag keys OSM itself treats as
// feature-defining, as opposed to attribute/meta keys like name, addr:*,
// source, or wikidata. An element groups under every one of these keys it
// carries (most only have one), so e.g. a way tagged both railway=rail
// and bridge=yes would appear under both "railway" and "bridge".
const PRIMARY_TYPE_KEYS = [
  'aerialway', 'aeroway', 'amenity', 'barrier', 'boundary', 'bridge',
  'building', 'craft', 'emergency', 'geological', 'healthcare', 'highway',
  'historic', 'landuse', 'leisure', 'man_made', 'military', 'natural',
  'office', 'place', 'power', 'public_transport', 'railway', 'route',
  'shop', 'sport', 'telecom', 'tourism', 'water', 'waterway'
];
const PRIMARY_TYPE_KEY_SET = new Set(PRIMARY_TYPE_KEYS);

// Groups elements by feature-type key, then by that key's value, e.g.
// waterway -> stream -> [elements]. Elements carrying none of
// PRIMARY_TYPE_KEYS (attribute-only tags, or a genuinely uncategorized
// key) land in `other` rather than being dropped -- "truly everything
// tagged" was the deliberate scope for this view.
function groupAllTypesElements(elements) {
  const groups = new Map();
  const other = [];

  for (const el of elements) {
    const tags = el.tags || {};
    const matchedKeys = Object.keys(tags).filter((key) => PRIMARY_TYPE_KEY_SET.has(key));
    if (matchedKeys.length === 0) {
      other.push(el);
      continue;
    }
    for (const key of matchedKeys) {
      if (!groups.has(key)) groups.set(key, new Map());
      const valueMap = groups.get(key);
      const value = tags[key];
      if (!valueMap.has(value)) valueMap.set(value, []);
      valueMap.get(value).push(el);
    }
  }

  return { groups, other };
}

let allTypesRequestToken = 0;

async function loadAndRenderAllTypes() {
  if (!lastBbox) return;
  const bbox = lastBbox;
  const token = ++allTypesRequestToken;
  streetList.innerHTML = '';
  setStatus('Loading all feature types...');

  let elements;
  try {
    elements = await fetchAllTypes(bbox);
  } catch (err) {
    if (token !== allTypesRequestToken || currentView !== 'all-types') return;
    setStatus('There was a problem retrieving all-types data from OpenStreetMap. Please try again.');
    return;
  }

  if (token !== allTypesRequestToken || currentView !== 'all-types') return;
  setStatus('');
  renderAllTypesView(elements);
}

function renderAllTypesView(elements) {
  streetList.innerHTML = '';
  const { groups, other } = groupAllTypesElements(elements);
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

  for (const key of sortedKeys) {
    const valueMap = groups.get(key);
    const totalCount = Array.from(valueMap.values()).reduce((sum, arr) => sum + arr.length, 0);

    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${key} (${totalCount})`;
    details.appendChild(summary);
    details.appendChild(buildAllTypesValueList(valueMap));
    li.appendChild(details);
    streetList.appendChild(li);
  }

  if (other.length) {
    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Other tags (${other.length})`;
    details.appendChild(summary);
    details.appendChild(buildAllTypesElementList(other));
    li.appendChild(details);
    streetList.appendChild(li);
  }

  if (!sortedKeys.length && !other.length) {
    const li = document.createElement('li');
    li.textContent = 'No tagged features found in this area.';
    streetList.appendChild(li);
  }
}

function buildAllTypesValueList(valueMap) {
  const ul = document.createElement('ul');
  const sortedValues = Array.from(valueMap.keys()).sort((a, b) => a.localeCompare(b));
  for (const value of sortedValues) {
    const elements = valueMap.get(value);
    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${value} (${elements.length})`;
    details.appendChild(summary);
    details.appendChild(buildAllTypesElementList(elements));
    li.appendChild(details);
    ul.appendChild(li);
  }
  return ul;
}

// Same phenomenon as street views' "N segments" grouping (see
// groupByStreetName) -- a single real-world feature (a creek, a park
// boundary, a rail line) is very often split across multiple OSM
// elements sharing one name tag, not multiple distinct features. Elements
// with no name at all can't be meaningfully grouped this way and are
// listed individually.
function buildAllTypesElementList(elements) {
  const ul = document.createElement('ul');
  const named = new Map();
  const unnamed = [];

  for (const el of elements) {
    const name = el.tags && el.tags.name;
    if (name) {
      if (!named.has(name)) named.set(name, []);
      named.get(name).push(el);
    } else {
      unnamed.push(el);
    }
  }

  const sortedNames = Array.from(named.keys()).sort((a, b) => a.localeCompare(b));
  for (const name of sortedNames) {
    const group = named.get(name);
    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = group.length > 1
      ? `${name} (${group.length} segments)`
      : `${name} — ${describeElement(group[0])}`;
    details.appendChild(summary);
    details.appendChild(group.length > 1 ? buildElementSegmentList(group) : buildTagList(group[0].tags));
    li.appendChild(details);
    ul.appendChild(li);
  }

  for (const el of unnamed) {
    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `(unnamed) — ${describeElement(el)}`;
    details.appendChild(summary);
    details.appendChild(buildTagList(el.tags));
    li.appendChild(details);
    ul.appendChild(li);
  }

  return ul;
}

function buildElementSegmentList(elements) {
  const ul = document.createElement('ul');
  elements.forEach((el, index) => {
    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Segment ${index + 1} — ${describeElement(el)}`;
    details.appendChild(summary);
    details.appendChild(buildTagList(el.tags));
    li.appendChild(details);
    ul.appendChild(li);
  });
  return ul;
}

function describeElement(el) {
  return `${el.geometryKind} · ${el.type} ${el.id}`;
}

function buildTagList(tags) {
  const ul = document.createElement('ul');
  const sortedKeys = Object.keys(tags).sort((a, b) => a.localeCompare(b));
  for (const key of sortedKeys) {
    const li = document.createElement('li');
    li.textContent = `${key} = ${tags[key]}`;
    ul.appendChild(li);
  }
  return ul;
}

function groupByStreetName(ways) {
  const groups = new Map();
  for (const way of ways) {
    const name = way.tags && way.tags.name;
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(way);
  }
  return groups;
}

function renderResults(ways) {
  lastWays = ways;
  streetList.innerHTML = '';

  const view = currentView;
  if (view === 'all-types') {
    loadAndRenderAllTypes();
  } else if (view === 'address') {
    renderAddressView(ways);
  } else if (view === 'braille-labels') {
    renderBrailleLabelsView(ways);
  } else {
    renderStandardView(ways, view);
  }
}

// § Label creation — testbed for tmap spec.md's abbreviation algorithm
// ("Braille labels" > "Label creation"), ahead of building it into DotTMAP
// itself. One flat list, "[street name] — [label]" per distinct street
// name in the current fetch, so uniqueness/collision handling can be
// checked against real Overpass data before the real placement/rendering
// work starts.
function renderBrailleLabelsView(ways) {
  const groups = groupByStreetName(ways);
  const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  const labels = assignBrailleLabels(names);

  for (const name of names) {
    const li = document.createElement('li');
    li.textContent = `${name} — ${labels.get(name)}`;
    streetList.appendChild(li);
  }
}

const LABEL_VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'A', 'E', 'I', 'O', 'U']);

// § Label creation, step 1 — strip vowels from each word of the name,
// except when a word (once its own punctuation is stripped) is a single
// vowel letter on its own, e.g. "A Street" or "E. 12th St." -- those words
// are kept whole. Runs on the original whitespace-separated words, since
// word boundaries still need to exist for this check; spaces themselves
// aren't removed until the next step.
function stripVowelsPreservingSingleLetterWords(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lettersOnly = word.replace(/[^A-Za-z]/g, '');
      if (lettersOnly.length === 1 && LABEL_VOWELS.has(lettersOnly)) return word;
      return [...word].filter((ch) => !LABEL_VOWELS.has(ch)).join('');
    })
    .join(' ');
}

// § Label creation, steps 1-3 — the full candidate string a street's label
// is drawn from: vowels stripped (per the single-letter-word exception),
// every space and punctuation character removed, lowercased.
function labelCandidateString(name) {
  const vowelsStripped = stripVowelsPreservingSingleLetterWords(name);
  return vowelsStripped.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

// § Label creation, steps 4-6 — assigns every street name a unique
// 3-character label. Processes names in the given order (alphabetical, so
// output is stable/reproducible run to run) -- uniqueness resolution is
// first-come-first-served, so earlier names in the list get first claim
// on their natural 3-letter window.
function assignBrailleLabels(names) {
  const used = new Set();
  const labels = new Map();

  for (const name of names) {
    const candidate = labelCandidateString(name);
    const label = findUniqueLabel(candidate, used) || findUniqueDigitSuffix(candidate, used);
    used.add(label);
    labels.set(name, label);
  }

  return labels;
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

// § Label creation, step 6 — every natural window collided, so fall back
// to the candidate's first two characters (padded with a dash if the
// candidate itself is shorter than 2 characters) plus a single trailing
// digit, trying 0-9 in order until one is unique.
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

function renderStandardView(ways, view) {
  const groups = groupByStreetName(ways);
  const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  const roadwayNames = view === 'unique-streets' ? computeRoadwayNames(ways) : null;

  for (const name of names) {
    let segments = groups.get(name);
    if (view === 'unique-streets') {
      segments = filterPairedPedestrianSegments(name, segments, roadwayNames);
    }

    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = segments.length > 1 ? `${name} (${segments.length} segments)` : name;
    details.appendChild(summary);
    details.appendChild(view === 'overview' ? buildAttributeList(segments) : buildHighwayValueList(segments));
    li.appendChild(details);
    streetList.appendChild(li);
  }
}

function renderAddressView(ways) {
  const groups = groupByStreetName(ways);
  const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

  for (const name of names) {
    const segments = groups.get(name);
    const li = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = segments.length > 1 ? `${name} (${segments.length} segments)` : name;
    details.appendChild(summary);
    details.appendChild(buildSegmentList(segments));
    li.appendChild(details);
    streetList.appendChild(li);
  }
}

function buildSegmentList(segments) {
  const ol = document.createElement('ol');

  segments.forEach((segment, index) => {
    const li = document.createElement('li');
    const segDetails = document.createElement('details');
    const segSummary = document.createElement('summary');
    segSummary.textContent = `Segment ${index + 1}`;
    segDetails.appendChild(segSummary);

    const addressList = document.createElement('ul');
    const startItem = document.createElement('li');
    startItem.textContent = 'Start: (expand to look up)';
    const endItem = document.createElement('li');
    endItem.textContent = 'End: (expand to look up)';
    addressList.appendChild(startItem);
    addressList.appendChild(endItem);
    segDetails.appendChild(addressList);

    let loaded = false;
    segDetails.addEventListener('toggle', () => {
      if (!segDetails.open || loaded) return;
      loaded = true;
      loadSegmentAddresses(segment, startItem, endItem);
    });

    li.appendChild(segDetails);
    ol.appendChild(li);
  });

  return ol;
}

async function loadSegmentAddresses(segment, startItem, endItem) {
  const geometry = segment.geometry || [];
  if (geometry.length === 0) {
    startItem.textContent = 'Start: no geometry available';
    endItem.textContent = 'End: no geometry available';
    return;
  }

  startItem.textContent = 'Start: looking up...';
  endItem.textContent = 'End: looking up...';

  const start = geometry[0];
  const end = geometry[geometry.length - 1];

  const [startAddress, endAddress] = await Promise.all([
    reverseGeocode(start.lat, start.lon),
    reverseGeocode(end.lat, end.lon)
  ]);

  startItem.textContent = `Start: ${startAddress}`;
  endItem.textContent = `End: ${endAddress}`;
}

let geocodeQueue = Promise.resolve();
const reverseGeocodeCache = new Map();

function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  if (reverseGeocodeCache.has(key)) {
    return reverseGeocodeCache.get(key);
  }

  const resultPromise = geocodeQueue.then(async () => {
    try {
      const url = `${NOMINATIM_REVERSE_URL}?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('reverse-geocode-failed');
      const data = await res.json();
      return formatShortAddress(data);
    } catch (err) {
      return 'address lookup failed';
    } finally {
      await wait(REVERSE_GEOCODE_DELAY_MS);
    }
  });

  geocodeQueue = resultPromise;
  reverseGeocodeCache.set(key, resultPromise);
  return resultPromise;
}

function formatShortAddress(data) {
  const address = data && data.address;
  if (!address) return 'no address found';
  const streetLine = [address.house_number, address.road].filter(Boolean).join(' ');
  return streetLine || 'no address found';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRoadwayNames(ways) {
  const names = new Set();
  for (const way of ways) {
    const name = way.tags && way.tags.name;
    const highway = way.tags && way.tags.highway;
    if (name && ROADWAY_HIGHWAY_VALUES.has(highway)) {
      names.add(name);
    }
  }
  return names;
}

function filterPairedPedestrianSegments(name, segments, roadwayNames) {
  if (!roadwayNames.has(name)) return segments;
  return segments.filter((seg) => !PEDESTRIAN_HIGHWAY_VALUES.has(seg.tags && seg.tags.highway));
}

function buildHighwayValueList(segments) {
  const counts = new Map();
  for (const seg of segments) {
    const value = seg.tags && seg.tags.highway;
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const sortedValues = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));

  const ul = document.createElement('ul');
  for (const value of sortedValues) {
    const li = document.createElement('li');
    li.textContent = `${value} (${counts.get(value)})`;
    ul.appendChild(li);
  }
  return ul;
}

function buildAttributeList(segments) {
  const keys = new Set();
  for (const seg of segments) {
    for (const key of Object.keys(seg.tags || {})) {
      if (key === 'name') continue;
      keys.add(key);
    }
  }
  const sortedKeys = Array.from(keys).sort((a, b) => a.localeCompare(b));

  const ul = document.createElement('ul');
  for (const key of sortedKeys) {
    const values = new Set();
    for (const seg of segments) {
      if (seg.tags && Object.prototype.hasOwnProperty.call(seg.tags, key)) {
        values.add(seg.tags[key]);
      }
    }
    const sortedValues = Array.from(values).sort((a, b) => a.localeCompare(b));

    const li = document.createElement('li');
    const attrDetails = document.createElement('details');
    const attrSummary = document.createElement('summary');
    attrSummary.textContent = key;
    attrDetails.appendChild(attrSummary);

    const valueText = document.createElement('p');
    valueText.textContent = sortedValues.join(', ');
    attrDetails.appendChild(valueText);

    li.appendChild(attrDetails);
    ul.appendChild(li);
  }
  return ul;
}

function setStatus(text) {
  statusMessage.textContent = text;
}

function clearResults() {
  lastWays = [];
  lastBbox = null;
  matchedLocation.textContent = '';
  streetList.innerHTML = '';
  copySvgStatus.textContent = '';
}

function projectToSvg(lat, lon, bbox) {
  const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * SVG_WIDTH;
  const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * SVG_HEIGHT;
  return { x, y };
}

function wayToPolylinePoints(way, bbox) {
  return (way.geometry || [])
    .map((point) => {
      const { x, y } = projectToSvg(point.lat, point.lon, bbox);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

function escapeXmlAttribute(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSvgDocument(ways, bbox) {
  const polylines = ways
    .filter((way) => (way.geometry || []).length >= 2)
    .map((way, index) => {
      const name = (way.tags && way.tags.name) || '';
      const id = `segment${String(index + 1).padStart(3, '0')}`;
      const points = wayToPolylinePoints(way, bbox);
      return `  <polyline data-name="${escapeXmlAttribute(name)}" id="${id}" points="${points}" fill="none" stroke="black" stroke-width="10"/>`;
    });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" width="${SVG_WIDTH}" height="${SVG_HEIGHT}">`,
    ...polylines,
    '</svg>'
  ].join('\n');
}
