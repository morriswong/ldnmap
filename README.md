# ldnmap

A travel-time visualisation tool for London. Pick a point on the map and instantly see how far you can walk, cycle, or drive in 5 / 10 / 15 / 20 minutes.

**Live:** [ldnmap.pages.dev](https://ldnmap.pages.dev)

## Features

- Isochrone overlays via the Mapbox Isochrone API (walking, cycling, driving)
- Location search with Mapbox Search Box (suggest + retrieve flow)
- Postcode boundary lookup via Ordnance Survey NGD API
- Area calculation for each time band (spherical polygon math, no library)
- Light / dark theme toggle
- Responsive layout: side panel on desktop, bottom sheet on mobile

## Tech

Zero-dependency static site — no framework, no bundler, no build step.

| File | Purpose |
|------|---------|
| `index.html` | Structure + CDN links |
| `style.css` | Layout, responsive rules, glass effects, theme variables |
| `app.js` | Map init, isochrone logic, search, UI state |

Built on **Leaflet 1.9** for the map and **Mapbox** for tiles, isochrones, and geocoding.

## Running locally

```bash
# Substitute real tokens for __MAPBOX_TOKEN__ and __OS_TOKEN__ in app.js, then:
python3 -m http.server
```

## Deploy

Cloudflare Pages via GitHub Actions. Tokens are injected at build time from repository secrets.

- `main` branch &rarr; production
- `dev` branch &rarr; preview
