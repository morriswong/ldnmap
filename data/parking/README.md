# Parking data (Hammersmith & Fulham)

Static files for the parking layer. The page fetches them from `/data/parking/` the first time
the layer is switched on. The GeoJSON files are built by `tools/build_parking.py`; `rules.json`
is written by hand from the council's zone times page.

| File | What it holds |
|---|---|
| `zones.geojson` | 31 controlled parking zone polygons. Properties: `zone` (letter), `lx`/`ly` (a point inside the zone for its label) |
| `rules.json` | Zone hours and max stays, event-day rules for T/X/Y, per-street exceptions (`specialStreets`), CO2 charge bands, the council PDF for each zone, and the yellow-line text |
| `streets.geojson` | Every street piece inside a zone. Properties: `name`, `zone`, `rule` (a key in `rules.zones` or `rules.specialStreets`), `tfl` (1 on TfL red routes, where zone rules don't apply), `cls` (1 = main road … 5 = service road) |
| `machines.geojson` | Ticket machines. Properties: `id`, `zone`, `type` (`Card only`, `Card & cash` or `Unknown`), `pdf` |
| `kerb.geojson` | Bays and yellow lines where OpenStreetMap has them. Properties: `kind` (`bay`, `single_yellow`, `double_yellow`), `side` (`left`, `right` or `both`, relative to the street's drawing direction), `zone` |

## Rules

Days are `0` = Sunday … `6` = Saturday. Times are Europe/London, `from` inclusive and `to`
exclusive. Each rule has `periods` (controlled times) and may have:

- `permit`: times when bays are for permit holders only (zone G 6:30–8pm, the G permit streets)
- `permitOnly`: the whole zone is permit holders only (QQ, VV)
- `event`: different `periods` and `maxStay` on Fulham FC event days (T, X, Y)

`parking-rules.js` turns these into `'ctrl'`, `'free'` or `'permit'` for a time
(`isControlled(ruleKey, day, minutes, eventDay)`); `tests/parking.test.mjs` tests it.

## Sources and gaps

- **Zones:** LBHF's Controlled Parking Zones layer on its INSPIRE map service
  (`rbkc.gov.uk/arcgis/rest/services/LBHF/INSPIRE/MapServer/10`). Its own hours fields are out of
  date, so hours come from `rules.json` instead. D (East) has no separate polygon.
- **Hours, max stays, special streets and charges:** the council's
  [zone times and charges](https://www.lbhf.gov.uk/parking/pay-and-display/parking-zone-times-and-charges)
  page, checked 8 November 2026. The Richford Street area streets come from the council's zone K
  consultation page. The page's CO2 bands overlap at 120 and 186 g/km; `rules.json` puts those
  values in the lower band.
- **Streets and red routes:** OpenStreetMap highways clipped to each zone. Red routes are ways with
  `operator=Transport for London`.
- **Ticket machines:** OpenStreetMap `vending=parking_tickets`. This covers only about 23 of the
  borough's roughly 300 machines and none record the payment type, so the layer says so and points
  to the zone PDFs, which show every machine.
- **Kerbs:** OpenStreetMap `parking:*` street parking tags. Only a few percent of streets are
  tagged. A blank kerb on the map means "not mapped", never "unrestricted". Red route kerbs are left
  out because red route signs apply there.

Data: LBHF; © OpenStreetMap contributors (ODbL).

## Rebuilding

```bash
python3 -m venv /tmp/pv && /tmp/pv/bin/pip install shapely
/tmp/pv/bin/python tools/build_parking.py
```

It caches the downloads in `/tmp/ldnmap-parking-cache` (set `PARKING_CACHE` to change that);
delete the cache to fetch fresh data.
