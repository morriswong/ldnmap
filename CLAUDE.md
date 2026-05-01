# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`ldnmap` is a static web app that visualises travel-time isochrones ("how far can you go?") on a Leaflet map. There is no build step, no package.json, no bundler.

## Architecture

Three files, all served statically:

- **`index.html`** — HTML structure, CDN links, `<link>` to `style.css`, `<script src="app.js">` at bottom of `<body>`
- **`style.css`** — all CSS: `:root` variables, layout, responsive rules, theme, glass effects
- **`app.js`** — all JavaScript: map init, isochrone logic, search, UI state, event handlers

Key subsystems in `app.js`:

- **Map layer**: Leaflet 1.9.4 (CDN) with Mapbox raster tiles (`streets-v12` for light, `dark-v11` for dark). Tile layer is rebuilt via `initTile()` whenever theme toggles.
- **Isochrones**: Mapbox Isochrone API (`/isochrone/v1/mapbox/<profile>/...`). Profiles: `walking`, `cycling`, `driving-traffic` (mapped from `driving`). Always requests four contours at `[5, 10, 15, 20]` minutes, colours hard-coded in `COLORS`.
- **Search**: Mapbox Search Box API — two-step `suggest` → `retrieve` flow, gated by a `sessionToken` (rotated after each successful retrieve, per Mapbox billing model). UK-biased (`country=gb`, `proximity` set to default centre).
- **Area calculation**: `calcArea` / `ringArea` compute spherical polygon area in km² locally from the returned GeoJSON — does not use a library.
- **Theme**: `body.light` class toggles a CSS-variable palette defined in `:root` and `body.light` in `style.css`. Default is light mode.
- **Responsive**: `@media (max-width: 768px)` rules in `style.css` reposition the panel from left side to bottom on mobile. Collapse animation direction (`translateX` vs `translateY`) is handled in the same rules.

State is held in plain script-level variables (`mode`, `center`, `marker`, `isoLayers`, `isDark`, `tileLayer`). No framework, no module system. `app.js` must load synchronously at the bottom of `<body>` (no `defer`/`async`/`type="module"`) because it queries the DOM immediately and inline `onclick` handlers reference its global functions.

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

Past failures: a one-line "zoom button blocked" complaint cascaded into 4 broken commits on production because we skipped reproduction and guessed at causes. Never again. For ANY visual, layout, mobile, iOS Safari, or Leaflet-UI bug, follow these five steps **in order**:

1. **Reproduce first**. Spawn the `visual-qa` agent (headless Chromium via Playwright MCP). Resize to the relevant viewport (default mobile: iPhone 390x844; desktop: 1280x800). Screenshot the *current* state. Inspect console. **If you don't have a screenshot of the actual problem, you don't have a diagnosis — do not edit code.**
2. **State the diagnosis as one sentence with evidence**: "Element X covers Element Y" or "Element X paints outside the viewport because Z". Cite the screenshot. If you can't write that sentence, you're guessing — go back to step 1.
3. **Library CSS interaction → grep first**. Any fix that touches Leaflet, Mapbox, or any third-party CSS requires reading or grepping the library's actual CSS to confirm positioning model (absolute / relative / floats / flex) before recommending `padding`, `margin`, `top`, etc. Children's positioning context determines whether parent styling propagates.
4. **Push to `dev` branch**. Wait for `dev.ldnmap.pages.dev` to deploy. Re-run `visual-qa` agent against the preview URL to verify the fix landed correctly. Production is never the test environment.
5. **User confirms on a real device** before merging dev → main.

## Methodology rules (general)

- **"Element X covers Y" + evidence** — if you can't produce the sentence with a screenshot, don't touch code
- **Library CSS interaction → grep first** — verify the library's positioning model before recommending CSS-property changes
- **Reviewer disagreement → flag the structural difference** — if two reviewers propose mechanically different solutions (e.g. `top` vs `padding-top`), state explicitly which is a correctness issue vs a style preference. Don't treat them as equal options.
- **Layered guesses → stop** — if the same visible bug has been shipped twice without resolution, the third attempt must not be another guess. Stop, request a fresh screenshot or live debug session.

## iOS Safari + Leaflet gotchas (do not relearn the hard way)

- iOS Safari **default `viewport-fit=auto` already keeps content inside the safe area**. `viewport-fit=cover` is a deliberate request to paint *under* the notch (immersive design only) — it is NOT a "turn on safe-area support" switch. Adding it makes content render under the status bar.
- `env(safe-area-inset-*)` only resolves to non-zero when `viewport-fit=cover` is set. Otherwise it falls back to whatever default you supply (or 0).
- Leaflet `.leaflet-top` is `position: absolute; top: 0`. Its zoom/control children are also positioned, so `padding-top` on `.leaflet-top` does NOT push them down — change `top` directly instead.
- Leaflet's zoom control default is `topright`. This app explicitly sets `position: 'topright'` in `app.js`. The mobile bottom-sheet panel does NOT overlap the zoom control — they are at opposite corners.
