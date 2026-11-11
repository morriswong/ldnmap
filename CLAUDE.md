# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`ldnmap` is a static web app that visualises travel-time isochrones ("how far can you go?") on a Mapbox GL JS map. The page has no build step and no bundler. The one server-side piece is the fuel price lookup's Cloudflare Pages Function (`functions/api/fuel.js`), which has no npm dependencies. `functions/` is never uploaded as static assets.

## Architecture

Four files plus `data/`, all served statically:

- **`index.html`** — HTML structure, CDN links, `<link>` to `style.css`, `<script src="app.js">` at bottom of `<body>`
- **`style.css`** — all CSS: `:root` variables, layout, responsive rules, theme, glass effects
- **`app.js`** — all JavaScript: map init, isochrone logic, search, UI state, event handlers
- **`parking-rules.js`** — the parking status logic, a plain script loaded before `app.js`
- **`data/parking/`** — the parking layer's data, built by `tools/build_parking.py`

Key subsystems in `app.js`:

- **Map layer**: Mapbox GL JS **v2.15.0** (CDN). Vector tile rendering via WebGL. Map style URLs use `mapbox://styles/mapbox/streets-v12` (light) and `mapbox://styles/mapbox/dark-v11` (dark). Style is swapped on theme toggle via `map.setStyle()` + `rehydrateLayers()`.
- **Isochrones**: Mapbox Isochrone API (`/isochrone/v1/mapbox/<profile>/...`). Profiles: `walking`, `cycling`, `driving-traffic` (mapped from `driving`). Always requests four contours at `[5, 10, 15, 20]` minutes, colours hard-coded in `COLORS`. Each contour is added as a Mapbox GL JS source+layer pair via `addIsoLayer()`.
- **Search**: Mapbox Search Box API — two-step `suggest` → `retrieve` flow, gated by a `sessionToken` (rotated after each successful retrieve, per Mapbox billing model). UK-biased (`country=gb`, `proximity` set to the map centre).
- **Postcode**: Ordnance Survey NGD API fetches a GeoJSON polygon for a UK postcode. Rendered as a Mapbox GL JS fill + line layer pair. Results are cached in `localStorage` for 30 days.
- **Theme**: `body.light` class toggles a CSS-variable palette defined in `:root` (dark defaults) and `body.light` (light overrides) in `style.css`. The page starts light (`<body class="light">`, light map) and `toggleTheme()` switches panel and map together. The theme button shows the theme a tap switches to (moon in light mode, sun in dark).
- **State machine**: `appState` is a string variable (`idle`, `search`, `modepicker`, `travel`) managed by `setState()`. `document.body.dataset.state` is set to match, which CSS uses to show/hide panels via `body[data-state="X"]` selectors.
- **Travel slots**: Four clickable cards (5/10/15/20 min). `selectedMin` tracks which is active. Each card has `--slot-color` as an inline CSS custom property; the left border uses this for color. Active state: glow `box-shadow`. Inactive slots dim to 40% opacity.
- **Responsive**: `@media (max-width: 768px)` rules in `style.css` switch the panel from a left-side sheet to a bottom sheet on mobile. Search uses a full-screen overlay on mobile (not inline) to avoid iOS keyboard viewport arithmetic.
- **Fuel prices** (`FUEL PRICES` section): a panel with a postcode/area input and fuel-type buttons that GETs `/api/fuel?location=&fuel=`, lists the 10 cheapest stations and plots them as the `fuel` GeoJSON source (`fuel-origin`, `fuel-circle`, `fuel-label` layers), rehydrated in `rehydrateLayers()`. The last search is remembered in `localStorage` (`ldnmap:fuelLast`). The panel opens from the postcode card's **Fuel Prices** button (next to Check Travel Time, looks up the card's postcode), the travel card's fuel-pump button (looks up the travel centre via `?lat=&lon=`, which the function turns into the nearest postcode with postcodes.io), or **Fuel prices near me** at the top of the search screen (browser geolocation; also the crosshair button in the panel). All of these are hidden unless `GET /api/fuel` returns `{enabled: true}` (env var `FUEL_ENABLED=true`). `fuelPoint` holds the point for point searches; typing in the panel's input clears it. On mobile the panel is a draggable bottom sheet like the travel card (both use `makeSnapSheet()` in the DRAGGABLE BOTTOM SHEET section); focusing the input pulls it to full height so the box stays above the keyboard. Server side: `functions/api/fuel.js` (one stateless MCP `tools/call` to the uk-fuel-mcp server); tests in `tests/` (`npm test`).

- **Parking** (`PARKING` section): the P button under the zoom buttons (a custom control) or the postcode card's P button turns the layer on; the panel's close button turns it off. The first time, it fetches `data/parking/rules.json` and `zones.geojson`; a borough's `streets`/`kerb`/`machines` files load when the map is over it at zoom ≥ 14.5 (`loadParkingDetail()` on `moveend`). All of it is built by `tools/build_parking.py` from `tools/parking_sources.json` (per-borough polygon service + the council's hours wording, parsed by `tools/parking_hours.py`; see `data/parking/README.md`). Sources `parking-zones`, `parking-zone-labels`, `parking-streets`, `parking-kerb`, `parking-machines`; layers `parking-zones-fill`, `parking-zones-line`, `parking-zones-label`, `parking-streets` (+ `parking-streets-sel` outline, minzoom 15), `parking-kerb-bay`/`-single`/`-double` (minzoom 16) and `parking-machines` (minzoom 15), re-added in `rehydrateLayers()`. Zones and streets are coloured by `isControlled(ruleKey, day, minutes, eventDay)` → `'ctrl' | 'free' | 'permit' | 'unknown'` at the day/time in the panel (London time; "Now" follows the clock); rule keys are `<borough>:<zone>`, and `unknown` (grey) means the council's hours couldn't be parsed, never a guess. Boroughs with no published zone boundaries (`listOnly`) are drawn as a dashed outline (`parking-borough-fill`/`-outline`); tapping one opens a card listing the council's zones and hours. That function lives in **`parking-rules.js`**, a plain script loaded before `app.js` so `tests/parking.test.mjs` can run it in Node. Below zoom 15 a tap on a zone zooms in; at street level a tap opens a street or zone card in the panel (a draggable sheet on mobile via `makeSnapSheet()`). Opening fuel prices turns parking off and vice versa, since the panels share a spot.

State is held in plain script-level variables: `mode`, `center`, `marker`, `isoLayers`, `isDark`, `selectedMin`, `postcodeLayer`, `pendingPlace`, `postcodeChipVisible`, `lastSearchQuery`, `lastRunArgs`, `appState`. No framework, no module system. `app.js` must load synchronously at the bottom of `<body>` (no `defer`/`async`/`type="module"`) because it queries the DOM immediately and inline `onclick` handlers reference its global functions.

Two conventions hold the state together:

- **The newest request wins.** Every lookup that can be overtaken takes a number from a counter when it starts (`runSeq` for isochrones and stations, `postcodeSeq` for boundaries, `fuelSeq`, `suggestSeq`) and stops when it comes back to find the counter has moved on. Anything that makes an answer unwanted (another search, a closed card) moves the counter. A new async lookup needs the same guard.
- **One way out of the travel view.** `clearTravel()` removes the isochrones, stations and bucket, cancels a run in flight and empties `lastRunArgs` (which doubles as "a travel view is showing"). Closing the card, going back, and picking another place (`goToPlace()` / `goToPostcode()`) all go through it; don't remove those layers piecemeal.

## Token injection (important)

`app.js` contains the literal placeholders `__MAPBOX_TOKEN__` and `__OS_TOKEN__`. The GitHub Actions workflow replaces them via `sed` at deploy time using repository secrets. **Never commit a real token.** For local testing, edit the placeholders in `app.js` temporarily and revert before committing.

## Deploy

Pushing to `main` or `dev` triggers `.github/workflows/deploy.yml`, which runs `npm test`, copies the site's files (`index.html`, `style.css`, `app.js`, `parking-rules.js`, `data/`) into `site/`, injects tokens into `site/app.js` and deploys that folder to Cloudflare Pages (project: `ldnmap`, account `a30a1eec7f8eb1e19439a3bc00d47beb`). A new top-level file the page needs must be added to the workflow's copy step.

- `main` → production at `ldnmap.pages.dev`
- `dev` → preview at `dev.ldnmap.pages.dev`

**All visual / responsive / mobile fixes go through `dev` first.** Only merge to `main` after the user confirms the preview URL on a real device.

## Local development

No build tooling. Serve with `python3 -m http.server` (needed for cross-file loading) after substituting real tokens in `app.js` for `__MAPBOX_TOKEN__` and `__OS_TOKEN__`.

`npm test` runs everything, with no install step and no network:

- `tests/app.test.mjs` runs `app.js` in a stand-in browser (`tests/helpers/browser-stub.mjs`: a small DOM, a Mapbox stub that throws on a duplicate source or layer like the real one, and a fake `fetch` whose answers a test can hold back). It checks state and map layers, including late and out-of-order answers. It can't see layout, so visual changes still need the workflow below.
- `tests/fuel.test.mjs` tests the Pages Function; `tests/parking.test.mjs` tests `parking-rules.js` and the data files.
- `python3 tools/parking_hours.py` self-tests the hours parser.

---

## Visual / mobile / responsive bug workflow (mandatory)

Past failures: a one-line "zoom button blocked" complaint cascaded into 4 broken commits on production because we skipped reproduction and guessed at causes. Never again. For ANY visual, layout, mobile, iOS Safari, or Mapbox GL JS UI bug, follow these five steps **in order**:

1. **Reproduce first**. Spawn the `visual-qa` agent (headless Chromium via Playwright MCP). Resize to the relevant viewport (default mobile: iPhone 390x844; desktop: 1280x800). Screenshot the *current* state. Inspect console. **If you don't have a screenshot of the actual problem, you don't have a diagnosis — do not edit code.**
2. **State the diagnosis as one sentence with evidence**: "Element X covers Element Y" or "Element X paints outside the viewport because Z". Cite the screenshot. If you can't write that sentence, you're guessing — go back to step 1.
3. **Library CSS interaction → grep first**. Any fix that touches Mapbox GL JS controls or any third-party CSS requires reading or grepping the library's actual CSS to confirm positioning model (absolute / relative / floats / flex) before recommending `padding`, `margin`, `top`, etc. Children's positioning context determines whether parent styling propagates.
4. **Push to `dev` branch**. Wait for `dev.ldnmap.pages.dev` to deploy. Re-run `visual-qa` agent against the preview URL to verify the fix landed correctly. Production is never the test environment.
5. **User confirms on a real device** before merging dev → main.

## Methodology rules (general)

- **"Element X covers Y" + evidence** — if you can't produce the sentence with a screenshot, don't touch code
- **Library CSS interaction → grep first** — verify the library's positioning model before recommending CSS-property changes
- **Reviewer disagreement → flag the structural difference** — if two reviewers propose mechanically different solutions (e.g. `top` vs `padding-top`), state explicitly which is a correctness issue vs a style preference. Don't treat them as equal options.
- **Layered guesses → stop** — if the same visible bug has been shipped twice without resolution, the third attempt must not be another guess. Stop, request a fresh screenshot or live debug session.

## Linear tickets

Always assign new Linear tickets for this repo to the `ldnmap` project (project ID: `70541a2f-aa3f-45a7-824b-2e5b015bfb6f`, team: `wch`).

---

## Mapbox GL JS gotchas (do not relearn the hard way)

### Version: use v2.15.0 strictly

- **Do not upgrade to v3.x.** Mapbox GL JS v3 has a strict style validator that incorrectly rejects the `"name"` root property found in Mapbox's own `streets-v12` and `dark-v11` styles — this produces a completely blank map with no error message. v2.15.0 is stable and fully compatible with all APIs in use.
- **Do not swap for MapLibre GL JS.** MapLibre cannot resolve `mapbox://` protocol URIs (fonts, sprites, tile sources) that appear inside Mapbox style JSON — this is proprietary SDK code removed in the fork. Mapbox GL JS handles these natively.

### Style reload and layer rehydration

- `map.setStyle()` destroys **all** sources and layers. One permanent `style.load` listener calls `rehydrateLayers()` to re-add ours, so a new GeoJSON source/layer must be added there too. It must stay safe to run twice: each add function removes what it is about to add.
- `whenStyleReady(fn)` is the helper for adding sources or layers: it calls `fn()` immediately if `map.isStyleLoaded()`, otherwise on the first of `style.load` or `idle`. Always use it.
- **Never pass `padding` to `flyTo`/`easeTo`/`jumpTo`.** It stays on the map and shifts every later move. Use `offset: paddingOffset(pad)`. `fitBounds` is fine: its padding only applies to that fit (and must go through `fitPadding()`, which keeps it smaller than the map).
- `style.load` is the correct event in v2 for both initial load and `setStyle()` reloads. Do not use `styledata` or poll `isStyleLoaded()` in a loop.

### Marker

- The map pin is a custom DOM element (`markerEl`) wrapped in `mapboxgl.Marker({ element: markerEl })`. Color is set directly on the element's `style`, not via Mapbox paint properties.
- `marker` (the script-level variable) is the positioned marker instance when active, or `null` when not placed.

### Zoom / navigation control

- `NavigationControl` is added at `top-right` with `showCompass: false`. There is no compass. The control is Mapbox GL JS native — do not attempt to style it as if it were Leaflet's `.leaflet-top`.
- Mapbox GL JS control containers use `.mapboxgl-ctrl` and `.mapboxgl-ctrl-group`. Their buttons are `position: relative` within a flex column — `padding` on the group DOES affect layout (unlike Leaflet's absolutely-positioned children).

---

## iOS Safari gotchas (do not relearn the hard way)

- **Input font-size must be ≥ 16px on mobile.** iOS Safari auto-zooms the viewport on any input with `font-size < 16px`. This is browser enforcement, not a glitch. The mobile media query overrides `.sinput { font-size: 16px; }` for this reason.
- **Use `position: fixed; inset: 0; overflow: hidden; overscroll-behavior: none` on `html, body`.** Without this, iOS shows a grey overscroll rubber-band bar beneath the map. `height: 100vh` alone is insufficient on iOS.
- **App height: use `--app-h` CSS variable, not `100vh`.** `syncAppHeight()` reads `visualViewport.height` (or `window.innerHeight` fallback) and sets `--app-h` on the root. `body` uses `height: var(--app-h, 100dvh)`. This is the reliable approach — `100vh` on iOS Safari includes the browser chrome and causes layout overflow.
- **Search input on mobile: use a full-screen overlay, not inline.** On iOS, tapping a search input fires `visualViewport.resize` asynchronously after the keyboard opens. Multiple attempts to cap panel height via focus/resize listeners all failed on real devices. The working solution is the full-screen `.search-overlay` (visible only on mobile via the `@media (max-width: 768px)` rule) — input at top, suggestions in middle, keyboard at bottom. No viewport arithmetic needed.
- **`viewport-fit=cover` is NOT a "safe-area support" switch.** It is a deliberate request to paint *under* the notch (immersive design). Do not add it unless you intend to handle safe areas manually. `viewport-fit=auto` (the default) already keeps content inside the safe area.
- **`env(safe-area-inset-*)` resolves to 0 without `viewport-fit=cover`.** Don't use safe-area env vars unless cover is also set.
- **Mapbox GL JS `NavigationControl` is at `top-right`.** The mobile bottom-sheet panel is at the bottom. They do not overlap. Do not add top-padding to the control group to "clear the notch" — they are at opposite corners.
