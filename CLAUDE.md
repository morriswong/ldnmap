# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`ldnmap` is a single-file static web app that visualises travel-time isochrones ("how far can you go?") on a Leaflet map. The entire app lives in `index.html` — HTML, CSS, and JS in one file. There is no build step, no package.json, no bundler.

## Architecture

Single file: `index.html` (~370 lines).

- **Map layer**: Leaflet 1.9.4 (CDN) with Mapbox raster tiles (`streets-v12` for light, `dark-v11` for dark). Tile layer is rebuilt via `initTile()` whenever theme toggles.
- **Isochrones**: Mapbox Isochrone API (`/isochrone/v1/mapbox/<profile>/...`). Profiles: `walking`, `cycling`, `driving-traffic` (mapped from `driving`). Always requests four contours at `[5, 10, 15, 20]` minutes, colours hard-coded in `COLORS`.
- **Search**: Mapbox Search Box API — two-step `suggest` → `retrieve` flow, gated by a `sessionToken` (rotated after each successful retrieve, per Mapbox billing model). UK-biased (`country=gb`, `proximity` set to default centre).
- **Area calculation**: `calcArea` / `ringArea` compute spherical polygon area in km² locally from the returned GeoJSON — does not use a library.
- **Theme**: `body.light` class toggles a CSS-variable palette defined in `:root` and `body.light`. Default is light mode.
- **Responsive**: A single `@media (max-width: 768px)` rule repositions the panel from left side to bottom on mobile. Collapse animation direction (`translateX` vs `translateY`) is handled in the same rule.

State is held in plain script-level variables (`mode`, `center`, `marker`, `isoLayers`, `isDark`, `tileLayer`). No framework, no module system.

## Token injection (important)

`index.html` contains the literal placeholder `__MAPBOX_TOKEN__` (see `var MAPBOX_TOKEN = '__MAPBOX_TOKEN__';`). The GitHub Actions workflow replaces it via `sed` at deploy time using the `MAPBOX_TOKEN` secret. **Never commit a real token.** For local testing, edit the placeholder temporarily and revert before committing.

## Deploy

Pushing to `main` or `dev` triggers `.github/workflows/deploy.yml`, which injects the Mapbox token and deploys to Cloudflare Pages (project: `ldnmap`, account `a30a1eec7f8eb1e19439a3bc00d47beb`).

- `main` → production at `ldnmap.pages.dev`
- `dev` → preview at `dev.ldnmap.pages.dev`

**All visual / responsive / mobile fixes go through `dev` first.** Only merge to `main` after the user confirms the preview URL on a real device.

## Local development

No tooling. Open `index.html` directly in a browser, or serve it (e.g. `python3 -m http.server`) after substituting a real token for `__MAPBOX_TOKEN__`. There are no tests, lints, or type checks.

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
- Leaflet's zoom control default is `topright`. This app explicitly sets `position: 'topright'` at `index.html:160`. The mobile bottom-sheet panel does NOT overlap the zoom control — they are at opposite corners.
