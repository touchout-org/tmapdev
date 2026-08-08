# Map Types -- considerations and definitions

## Street Maps

For individual pedestrian wayfinding or understanding of highly-specific local feature placement. 
Useful at up to 1in:2000ft
Features include:
* all streets, paths, highways, steps, etc.
* transit stops
* parks
* waterways
* political boundaries -- neighborhood, town, city, county, state, country.

## Regional Maps

Covers what were sketched as separate "Highway" and "Region" map types -- highway-network viewing turns out to be the near end of one continuous scale range, not a distinct type. Understanding highway/freeway networks, where cities sit relative to each other and to major geography, up through entire states/provinces.

**Scale range:** 1 mile to 100 miles to the inch. Picks up right where Street Maps' own ladder tops out (`SCALE_PRESETS_FT`'s last step is 5000 ft/inch, ≈0.95 mi/inch).

**Fetch box:** 600 × 400 miles, fixed regardless of which scale within the range you're currently viewing -- sized so the full fetched area fits on the Dot Pad display (labels off) at the type's largest scale, 100 mi/inch (6.1875 in × 4.125 in display → ≈618 × 412 mi, rounded to the clean 600 × 400). Same 3:2 aspect ratio the display and the fetch box already share everywhere else in this app. This is a genuinely large box compared to Street Maps' -- real query performance against it (Postpass response time, payload size) is untested; expect to tune the size thresholds below tighter if it turns out slow, rather than shrinking the box itself.

**Scale steps** (continuing Street Map's existing pattern -- see `SCALE_PRESETS_FT`/`SCALE_PRESETS_M` in app.js -- dense round numbers at the small end, sparser jumps at the large end):

| Index | Imperial (mi/in) | Metric (km/cm) |
|---|---|---|
| 0 | 1 | 0.6 |
| 1 | 2 | 1.2 |
| 2 | 3 | 2 |
| 3 | 5 | 3 |
| 4 | 10 | 6 |
| 5 | 15 | 10 |
| 6 | 25 | 15 |
| 7 | 40 | 25 |
| 8 | 60 | 40 |
| 9 | 100 | 60 |

Metric column derived the same way `SCALE_PRESETS_M` was (matching *scale ratio*, not raw distance, to a clean round metric number -- see app.js's own comment on that ladder). **Provisional** -- the original ladder got real calibration scrutiny (documented rounding tradeoffs down to ~17% at the smallest preset); this one hasn't had that pass yet.

Includes:
* major highways (see Highways below)
* cities and towns, as points AND as polygons (see Cities below)
* counties, states/provinces, as polygons (see Political Boundaries below)
* waterways, standing water, and coastlines (see Waterways below)
* parks, at the appropriate (near) end of the range only (see Parks below)

### Minimum Feature Size rule (general rule, not just Regional Maps)

To keep downloads small without an unfiltered "grab everything" query (the mistake the OSM Data Mine experiment made -- see its All Types tab, which routinely pulls 2,000+ elements and takes 7-20+ seconds): any feature whose real-world size would render smaller than **2 inches long (lines) or 2 in² (areas)** at a map type's own **smallest scale** (its nearest/most-zoomed-in end -- for Regional Maps, 1 in = 1 mile, the top row of the scale table above) is excluded from that type's query entirely, not merely hidden at render time.

This is a floor computed once at fetch time, not a per-zoom-step recalculation. It's deliberately the *most permissive* end of the range (least real-world size needed to clear 2 in²), so the single upfront download stays broadly useful across the whole scale range -- it's fine, and expected, for some of what got downloaded to be too small to sensibly render once you've zoomed out toward 100 mi/inch. That's handled by rendering-time simplification as scale changes (the same role Auto Simplification already plays for Street Maps' street clutter), not by re-fetching or by a stricter download-time floor.

Postpass makes this cheap: `postpass_line` carries a computed `length_m` column and `postpass_polygon` a computed `area_m2` column, on every row, regardless of tag -- both usable directly as a `WHERE` clause. **Decided: Regional Maps design against Postpass only** -- no Overpass fallback path planned or needed; if Postpass itself becomes unreliable, the response is self-hosting a Postpass instance, not switching data sources. This removes what had been an open architectural question.

Using the same smallest-scale reference for every feature type in a map type (rather than picking a different one per feature, as an earlier draft of this rule mistakenly did) is what makes this reusable elsewhere: one number per map type, computed once, applied uniformly.

**Companion pattern -- top-N as a safety valve on top of the size floor:** a size floor alone doesn't cap how many features could qualify in an unusually dense area (a region thick with rivers or parks that all clear 2 mi/2 sq mi). Cities below uses `ORDER BY <size> DESC LIMIT N` for exactly this reason -- worth reusing for any other feature type where testing turns up a dense-area blowup, not just cities.

### Highways

`highway IN ('motorway','trunk','primary')`, substituting `ref` for honorary names the same way Street Maps already do for major highways (issue #19). `motorway`/`trunk` are **exempt from the length filter** (confirmed, matches which tiers already get ref-substitution) -- a short connector/interchange segment of an otherwise-continuous interstate won't get dropped and break the route's visual continuity, same reasoning as coastline's exemption. `primary` roads get the standard `length_m >= 3219` (2 mi) filter.

### Waterways, Standing Water, and Coastlines

Reference scale: Regional's smallest scale, 1 mi/inch → **2 mi minimum length / 2 sq mi minimum area**.

* `waterway=river` and `waterway=canal` (not `stream`/`drain`/`ditch` -- see the earlier discussion on why OSM's stream/river split is informal, not a real hierarchy), `length_m >= 3219` (2 mi in meters).
* `natural=water` (lakes, reservoirs, ponds -- standing water, not covered anywhere until now despite "lake" being one of the very first water types you asked about). Area rule: `area_m2 >= 5,180,000` (2 sq mi). A `water=*` sub-tag exists (`lake`/`pond`/`reservoir`/`lagoon`) but isn't needed as a filter -- the size threshold alone does the job a `water=pond` vs `water=lake` distinction would have tried to do, more reliably.
* `natural=coastline`, **exempt from the length filter** (confirmed) -- always included regardless of segment length, so a continuous coast never shows gaps just because some of its OSM segments happen to be short.
* `natural=bay` and `natural=strait` (confirmed, added). OSM tags these inconsistently as either a point or a polygon depending on how well-defined the mapper considered the shoreline -- worth checking which SF Bay itself actually is before finalizing this. Where it's a polygon: same `area_m2 >= 5,180,000` rule as standing water. Where it's only a point, there's no `area_m2` to filter on at all -- same situation as Cities below, so the same open question applies (include by tag/name alone, no size gate, same as coastline's exemption above).
* `name` required, matching Street Maps' own `highway`+`name` pattern -- an unnamed river/lake/coastline segment can't be usefully labeled anyway.

### Parks

Reference scale: Regional's smallest scale, 1 mi/inch → **2 sq mi minimum area**, same reference scale as Waterways above (see Minimum Feature Size).

* `boundary=national_park` and `boundary=protected_area` -- included by tag alone, **no size filter**. These are the closest things to a reliable "this is a real park, not a pocket green space" signal OSM has; a small but formally-designated protected area should still show.
* `leisure=park` (no cleaner tag exists for most state parks) -- included only if `area_m2 >= 5,180,000` (2 sq mi). At this threshold, typical city parks and playgrounds stay excluded (Golden Gate Park ≈1.5 sq mi, Central Park ≈1.3 sq mi -- both still under it) while state parks and larger urban parks (Griffith Park ≈4.3 sq mi) and anything national-park-scale clear it easily.
* `name` required.

### Cities

* **As points (revised -- server-side ranking, not a tag/population floor):** rather than a `place=` tag cut or a fixed `population >` threshold (either bakes in an assumption about what counts as "big," which varies by country), rank by population and cap the count server-side:

  ```sql
  SELECT osm_id, tags, geom
  FROM postpass_point
  WHERE geom && ST_MakeEnvelope(west,south,east,north,4326)
    AND tags ? 'place'
  ORDER BY
    CASE WHEN tags->>'population' ~ '^[0-9]+$'
         THEN (tags->>'population')::bigint
         ELSE 0
    END DESC
  LIMIT 50
  ```

  `population` is stored as text (like every OSM tag value), so a straight numeric cast would throw on a missing or malformed value -- the `CASE`/regex guard sorts those to the bottom instead of excluding or crashing on them, so a real settlement missing just its population tag can still make the cut if there's room. `LIMIT` (50 above, a placeholder) is a testing knob, not a decided number -- always returns the N largest places in the box regardless of what "large" means locally. `population` is *also* still used downstream to prioritize rendering/labeling as scale changes, same role Auto Simplification plays for street clutter -- this query just additionally caps it at fetch time too.
* **As polygons:** `boundary=administrative` at the city-tier `admin_level` (8, see Political Boundaries -- US values, decided below). Filtered by `admin_level`, not by size or population, same reasoning as Political Boundaries.
* `name` required for both.

### Political Boundaries -- Counties and States

`boundary=administrative` + `admin_level`: state/province = **4**, county = **6**, city = **8** (US values, decided -- international variation is explicitly out of scope for this first round; special-case by location later if needed). **`admin_level` is the primary filter here, not `area_m2`** -- unlike waterways/parks, OSM's admin boundaries already have the real, consistently-applied hierarchy that waterways lack (this is the good news from the earlier discussion), so there's no need to lean on size at all for these.

A state or county polygon that only barely clips the edge of the 600×400 mi bounding box would otherwise come back as its *entire* geometry (Postpass, like Overpass, doesn't clip to the query bbox by default -- see the existing "way that only partially crosses the bbox still comes back complete" caveat in OSMExperiments.md, which applies equally to a much bigger state-sized polygon, and matters more here given how large this box already is). Resolved via server-side clipping: keep `geom && envelope` in `WHERE` for the indexed candidate search, but wrap the `SELECT`ed geometry in `ST_Intersection(geom, envelope)` so only the portion actually inside the box comes back --

```sql
SELECT osm_id, tags, ST_Intersection(geom, ST_MakeEnvelope(west,south,east,north,4326)) AS geom
FROM postpass_polygon
WHERE geom && ST_MakeEnvelope(west,south,east,north,4326)
  AND tags->>'boundary' = 'administrative' AND tags->>'admin_level' IN ('4','6')
```

The clipped polygon gets a straight new edge wherever it crosses the box -- expected, not a data problem, any windowed map does this.

`name` required.

## Political Maps

For viewing entire countries or groups of countries.
50-500 miles to the inch
* political boundaries
* waterways
* major/Capital cities

## Topographical maps

For displaying slopes and elevations; mountains, hills, etc.
Any scale
At larger scales, only display larger elevation changes.

## Hydrological Maps

for displaying coastlines, rivers, lakes
Any scale

## Weather Maps




## Feature Types

* Points
* Lines
* Areas

