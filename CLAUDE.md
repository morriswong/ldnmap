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
- **Responsive**: A single `@media (max-width: 600px)` rule repositions the panel from left side to bottom on mobile. Collapse animation direction (`translateX` vs `translateY`) is handled in the same rule.

State is held in plain script-level variables (`mode`, `center`, `marker`, `isoLayers`, `isDark`, `tileLayer`). No framework, no module system.

## Token injection (important)

`index.html` contains the literal placeholder `__MAPBOX_TOKEN__` (see `var MAPBOX_TOKEN = '__MAPBOX_TOKEN__';`). The GitHub Actions workflow replaces it via `sed` at deploy time using the `MAPBOX_TOKEN` secret. **Never commit a real token.** For local testing, edit the placeholder temporarily and revert before committing.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which injects the Mapbox token and deploys the repo root to Cloudflare Pages (project: `ldnmap`, account `a30a1eec7f8eb1e19439a3bc00d47beb`). There is no staging environment.

## Local development

No tooling. Open `index.html` directly in a browser, or serve it (e.g. `python3 -m http.server`) after substituting a real token for `__MAPBOX_TOKEN__`. There are no tests, lints, or type checks.
