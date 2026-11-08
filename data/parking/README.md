# Parking data (London boroughs)

Static files for the parking layer. The page fetches `rules.json` and `zones.geojson` the first
time the layer is switched on, and a borough's `streets`, `kerb` and `machines` files when the
map is over that borough at street level. Everything is built by `tools/build_parking.py` from
the sources listed in `tools/parking_sources.json`.

| File | What it holds |
|---|---|
| `rules.json` | `boroughs`: one entry per borough (name, `bbox`, council URLs, `checked` date, yellow-line wording, charges, `zoneCount`, `knownHours`, `detail` when it has street files, `listOnly` when it has no zone boundaries). `rules`: one rule per zone or street rule, keyed `"<borough>:<zone>"` (`hf:E`) or `"<borough>:<street rule>"` (`hf:K-Richford`); a `listOnly` borough's rules have no geometry and are shown as a list |
| `zones.geojson` | Every zone polygon. Properties: `b` (borough id), `zone`, `rule`, `lx`/`ly` (a point inside the zone for its label). Boroughs that publish no zone boundaries have one feature with `outline: 1` instead: their borough boundary (London Datastore, OGL) |
| `<borough>/streets.geojson` | Street pieces inside that borough's zones. Properties: `name`, `zone`, `rule`, `tfl` (1 on TfL red routes, where zone rules don't apply), `cls` (1 = main road … 5 = service road) |
| `<borough>/machines.geojson` | Ticket machines from OpenStreetMap: `id`, `zone`, `type` (`Card only`, `Card & cash`, `Unknown`), `pdf` |
| `<borough>/kerb.geojson` | Bays and yellow lines where OpenStreetMap has them: `kind` (`bay`, `single_yellow`, `double_yellow`), `side` (`left`, `right`, `both`, relative to the street's drawing direction), `zone` |

## Rules

Days are `0` = Sunday … `6` = Saturday. Times are Europe/London, `from` inclusive and `to`
exclusive. Each rule has:

- `hours`: the council's own wording (shown on the card)
- `periods`: controlled times parsed from it by `tools/parking_hours.py`, or `null` when the wording
  couldn't be read. A `null` rule is shown grey ("hours unknown"), never coloured by a guess.
- optional `maxStay`, `note`, `pdf`/`url`, `permit` (permit-holders-only times), `permitOnly`
  (whole zone), `event` (different `periods`/`maxStay` on event days), `streets` (a street rule:
  the named streets in `zone` follow this rule instead of the zone's)

`parking-rules.js` turns these into `'ctrl'`, `'free'`, `'permit'` or `'unknown'`
(`isControlled(ruleKey, day, minutes, eventDay)`); `tests/parking.test.mjs` tests it.

## Coverage

Every London borough (and the City) is in `tools/parking_sources.json`. Where a council publishes zone
boundaries in a machine-readable form they are drawn and coloured; where it publishes only a web list
of zones and hours, the borough is outlined and the list is shown; where it publishes neither, the
outline carries a note and a link. Nothing is traced from PDFs or guessed.

## Sources and gaps

Per borough, `tools/parking_sources.json` records the polygon service and the council page the
hours were copied from (verbatim) with the date they were checked. In general:

- **Zones** come from each council's own GIS service or open-data download. Their attribute hours
  are often stale, so hours come from the council's current web page instead.
- **Hours** are the council's wording, parsed by `tools/parking_hours.py` (run it to self-test).
  Anything it can't read stays `null`, and the build log lists those zones.
- **Streets and red routes:** OpenStreetMap highways clipped to each zone; red routes are ways with
  `operator=Transport for London`.
- **Ticket machines:** OpenStreetMap `vending=parking_tickets`. OSM has only a small fraction of
  machines and rarely records the payment type.
- **Kerbs:** OpenStreetMap `parking:*` street parking tags, on only a few percent of streets. A blank
  kerb means "not mapped", never "unrestricted". Red route kerbs are left out.

Data: London borough councils (per-borough licences in `parking_sources.json`); © OpenStreetMap
contributors (ODbL).

## Rebuilding

```bash
python3 -m venv /tmp/pv && /tmp/pv/bin/pip install shapely pyproj pyshp
/tmp/pv/bin/python tools/build_parking.py            # every borough
/tmp/pv/bin/python tools/build_parking.py hf camden  # some boroughs; the rest are kept
```

Downloads are cached in `/tmp/ldnmap-parking-cache` (set `PARKING_CACHE` to change that); delete
the cache to fetch fresh data.
