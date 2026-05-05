# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`ldnmap` is a static web app that visualises travel-time isochrones ("how far can you go?") on a Mapbox GL JS map. There is no build step, no package.json, no bundler.

## Architecture

Three files, all served statically:

- **`index.html`** — HTML structure, CDN links, `<link>` to `style.css`, `<script src="app.js">` at bottom of `<body>`
- **`style.css`** — all CSS: `:root` variables, layout, responsive rules, theme, glass effects
- **`app.js`** — all JavaScript: map init, isochrone logic, search, UI state, event handlers

Key subsystems in `app.js`:

- **Map layer**: Mapbox GL JS **v2.15.0** (CDN). Vector tile rendering via WebGL. Map style URLs use `mapbox://styles/mapbox/streets-v12` (light) and `mapbox://styles/mapbox/dark-v11` (dark). Style is swapped on theme toggle via `map.setStyle()` + `rehydrateLayers()`.
- **Isochrones**: Mapbox Isochrone API (`/isochrone/v1/mapbox/<profile>/...`). Profiles: `walking`, `cycling`, `driving-traffic` (mapped from `driving`). Always requests four contours at `[5, 10, 15, 20]` minutes, colours hard-coded in `COLORS`. Each contour is added as a Mapbox GL JS source+layer pair via `addIsoLayer()`.
- **Search**: Mapbox Search Box API — two-step `suggest` → `retrieve` flow, gated by a `sessionToken` (rotated after each successful retrieve, per Mapbox billing model). UK-biased (`country=gb`, `proximity` set to default centre).
- **Postcode**: Ordnance Survey NGD API fetches a GeoJSON polygon for a UK postcode. Rendered as a Mapbox GL JS fill + line layer pair. Results are cached in `localStorage` for 30 days.
- **Theme**: `body.light` class toggles a CSS-variable palette defined in `:root` (dark defaults) and `body.light` (light overrides) in `style.css`. Initial render: dark panel CSS + light map. After first toggle they sync: dark+dark ↔ light+light.
- **State machine**: `appState` is a string variable (`idle`, `search`, `modepicker`, `travel`) managed by `setState()`. `document.body.dataset.state` is set to match, which CSS uses to show/hide panels via `body[data-state="X"]` selectors.
- **Travel slots**: Four clickable cards (5/10/15/20 min). `selectedMin` tracks which is active. Each card has `--slot-color` as an inline CSS custom property; the left border uses this for color. Active state: glow `box-shadow`. Inactive slots dim to 40% opacity.
- **Responsive**: `@media (max-width: 768px)` rules in `style.css` switch the panel from a left-side sheet to a bottom sheet on mobile. Search uses a full-screen overlay on mobile (not inline) to avoid iOS keyboard viewport arithmetic.

State is held in plain script-level variables: `mode`, `center`, `marker`, `isoLayers`, `isDark`, `selectedMin`, `postcodeLayer`, `pendingPlace`, `postcodeChipVisible`, `lastSearchQuery`, `appState`. No framework, no module system. `app.js` must load synchronously at the bottom of `<body>` (no `defer`/`async`/`type="module"`) because it queries the DOM immediately and inline `onclick` handlers reference its global functions.

## Token injection (important)

`app.js` contains the literal placeholders `__MAPBOX_TOKEN__` and `__OS_TOKEN__`. The GitHub Actions workflow replaces them via `sed` at deploy time using repository secrets. **Never commit a real token.** For local testing, edit the placeholders in `app.js` temporarily and revert before committing.

## Deploy

Pushing to `main` or `dev` triggers `.github/workflows/deploy.yml`, which injects tokens into `app.js` and deploys to Cloudflare Pages (project: `ldnmap`, account `a30a1eec7f8eb1e19439a3bc00d47beb`).

- `main` → production at `ldnmap.pages.dev`
- `dev` → preview at `dev.ldnmap.pages.dev`

**All visual / responsive / mobile fixes go through `dev` first.** Only merge to `main` after the user confirms the preview URL on a real device.

## Local development

No tooling. Serve with `python3 -m http.server` (needed for cross-file loading) after substituting real tokens in `app.js` for `__MAPBOX_TOKEN__` and `__OS_TOKEN__`. There are no tests, lints, or type checks.

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

- `map.setStyle()` destroys **all** sources and layers. After calling it, you must call `rehydrateLayers()` inside a `style.load` listener to re-add any GeoJSON sources/layers.
- `whenStyleReady(fn)` is the helper for this: it calls `fn()` immediately if `map.isStyleLoaded()`, otherwise defers via `map.once('style.load', fn)`. Always use this when adding sources or layers.
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
