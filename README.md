# ldnmap

A travel-time visualisation tool for London. Pick a point on the map and instantly see how far you can walk, cycle, or drive in 5 / 10 / 15 / 20 minutes.

**Live:** [ldnmap.pages.dev](https://ldnmap.pages.dev)

## Features

- Isochrone overlays via the Mapbox Isochrone API (walking, cycling, driving)
- Location search with Mapbox Search Box (suggest + retrieve flow)
- Postcode boundary lookup via Ordnance Survey NGD API
- Fuel prices (optional): from a postcode card, the travel card, or **Fuel prices near me** on the search screen; the cheapest stations appear in a list and on the map
- Parking (Hammersmith & Fulham): the **P** button colours controlled parking zones and streets red (controlled), green (free) or purple (permit holders only) at any day and time, and tapping a street shows its hours, max stay, yellow-line rules, nearby ticket machines and charges
- Light / dark theme toggle
- Responsive layout: side panel on desktop, bottom sheet on mobile

## Tech

Static site — no framework, no bundler, no build step for the page itself.

| File | Purpose |
|------|---------|
| `index.html` | Structure + CDN links |
| `style.css` | Layout, responsive rules, glass effects, theme variables |
| `app.js` | Map init, isochrone logic, search, fuel prices, UI state |
| `parking-rules.js` | Parking status logic (`isControlled`), loaded before `app.js` and unit-tested |
| `data/parking/` | Static parking data for the parking layer (see its README) |
| `functions/api/fuel.js` | Cloudflare Pages Function behind the fuel price lookup (no dependencies) |

Built on **Mapbox GL JS** for the map, tiles, isochrones, and geocoding.

## Running locally

```bash
# Substitute real tokens for __MAPBOX_TOKEN__ and __OS_TOKEN__ in app.js, then:
python3 -m http.server
```

## Deploy

Cloudflare Pages via GitHub Actions. Tokens are injected at build time from repository secrets.

- `main` branch &rarr; production
- `dev` branch &rarr; preview

## Fuel prices

`GET /api/fuel?location=E8%204QN&fuel=E10` (or `?lat=51.5&lon=-0.12&fuel=E10`, looked up as the nearest postcode via postcodes.io) calls the `cheapest_fuel_near` tool on the [uk-fuel-mcp](https://github.com/morriswong/uk-fuel-mcp) server (a Cloudflare Worker) with one MCP request and returns its JSON: the 10 cheapest stations within 5 miles, which the panel lists and the map plots. Fuel codes: `E10` (petrol), `E5` (super), `B7_STANDARD` (diesel), `B7_PREMIUM` (premium diesel). The Fuel Prices button on the postcode card only shows when `GET /api/fuel` reports the endpoint is enabled.

Set these in Cloudflare Pages → ldnmap → Settings → Variables and Secrets, per environment (Preview covers `dev`, Production covers `main`; the deploy workflow sets them for the branch's environment from the repo secrets of the same name):

| Name | Value |
|------|-------|
| `FUEL_ENABLED` | `true` to switch the lookup on (anything else → 404, button hidden) |
| `FUEL_MCP_URL` | MCP endpoint of uk-fuel-mcp (`https://uk-fuel-mcp.<subdomain>.workers.dev/mcp`) |
| `FUEL_MCP_TOKEN` | A key from the server's `MCP_API_KEYS` (secret) |

The function caps locations at 60 characters and rate-limits each IP to 30 lookups a minute per isolate.

```bash
npm test                       # function tests, no network
npx wrangler pages dev . --binding FUEL_ENABLED=true   # runs the function locally
```
