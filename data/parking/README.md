# Parking data (London boroughs)

Static files for the parking layer. The page fetches `rules.json` and `zones.geojson` the first
time the layer is switched on, and a borough's `streets`, `kerb` and `machines` files when the
map is over that borough at street level. Everything is built by `tools/build_parking.py` from
the sources listed in `tools/parking_sources.json`.

| File | What it holds |
|---|---|
| `rules.json` | `bankHolidays`: England and Wales bank holidays as ISO dates (gov.uk, OGL; refreshed by `tools/update_bank_holidays.py`). `boroughs`: one entry per borough (name, `bbox`, council URLs, `checked` date, yellow-line wording, charges, optional `bankHolidays` (`"free"` or `"charged"`: what pay and display does on bank holidays; absent = not known) and `maxStayDefault` (the council's default max stay), `zoneCount`, `knownHours`, `detail` when it has street files, `listOnly` when it has no zone boundaries). `rules`: one rule per zone or street rule, keyed `"<borough>:<zone>"` (`hf:E`) or `"<borough>:<street rule>"` (`hf:K-Richford`); a `listOnly` borough's rules have no geometry and are shown as a list |
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
- optional `unsure` (times shown as unknown, e.g. where two zones drawn as one area differ),
  `maxStay`, `note`, `pdf`/`url`, `permit` (permit-holders-only times), `permitOnly`
  (whole zone), `event` (different `periods`/`maxStay` on event days), `streets` (a street rule:
  the named streets in `zone` follow this rule instead of the zone's), `bankHolidays` (overrides the
  borough's) with `bankHolidayExcept` (`["12-25"]`: month-days that are free even so), `price`
  (`{perHour, note}`: this zone's own hourly price, when it differs from the borough's charges) and
  `payCode` (`{provider: "RingGo", code}`: the pay-by-phone location code)

Borough `charges` take one of three shapes: emissions `bands` (`[{band, co2, perHour}]`, with
`dieselPerHour`), `{model: "flat", perHour}`, `{model: "fuel", byFuel: {electric, petrol, diesel, other}}`
(per hour, as RingGo lists them), `{model: "zone"}` (each rule has its own `price`) or `{model: "note"}`
(prices set street by street; only the `note` and link). All can carry `visitorFromPerHour`, `note`,
`url` and `checked` (the date the prices were read). Borough `payProvider` names the pay-by-phone
service (`"RingGo"` or `"PayByPhone"`), and `ringgo` in `parking_sources.json`
(`{slug, locations: {code: lastTariffUpdate}}`) is what `tools/check_parking_sources.py` watches.

On a bank holiday (`isControlled(…, bankHoliday)`, where `bankHoliday` is the date's `'MM-DD'` or
`true`), event-day hours win on an event day; otherwise a `"free"` policy is free, `"charged"` keeps
the normal hours, and with no policy (or `"unknown"`, for a zone whose council says it varies) anything
that would be controlled shows as unknown.

`parking-rules.js` turns these into `'ctrl'`, `'free'`, `'permit'` or `'unknown'`
(`isControlled(ruleKey, day, minutes, eventDay, bankHoliday)`) and finds the next change
(`nextChange`, for the card's "free from 10pm"); `tests/parking.test.mjs` tests it.

## Coverage

Every London borough (and the City) is in `tools/parking_sources.json`. Where a council publishes zone
boundaries in a machine-readable form they are drawn and coloured. Where it publishes them only as a
map (a PDF or a web map), they are traced from that map and placed by fitting the map's own borough or
ward boundary to the real one; where it publishes a list of streets per zone, each zone is drawn
around those streets in OpenStreetMap. Each such borough's `notes` says which, with the fit's error.
Where a council publishes only a web list of zones and hours, the borough is outlined and the list is
shown; where it publishes neither, the outline carries a note and a link. Hours are never guessed:
times the council's wording doesn't settle are `unsure` (shown as unknown).

## Keeping it current

`.github/workflows/parking-watch.yml` runs `tools/check_parking_sources.py` every Monday. It opens a
`parking-data` issue when a MyRingGo location's "Last tariff update" changes (boroughs with a `ringgo`
entry in `parking_sources.json`: `{slug, locations: {code: last update}}`), when a London borough
publishes or changes a parking traffic order in the DfT's D-TRO service (`tools/dtro.py`; boroughs are
matched by their GeoPlace `swaCode`; needs the `DTRO_CLIENT_ID`/`DTRO_CLIENT_SECRET` secrets), or when
the bank holiday list is about to run out. It logs how many orders each borough has in D-TRO, since
councils are still joining. For boroughs not in D-TRO yet it reads parking notices from the councils'
own websites (`tools/council_notices.py`: Richmond, Westminster, Kensington & Chelsea, City of London,
Islington, Brent, Merton, Ealing, Wandsworth). H&F, Camden, Southwark, Barking & Dagenham, Bromley,
Harrow, Havering and Hillingdon refuse scripted requests, as does the London Gazette, so those are
checked by hand (`tools/gazette_watch.md`) and filed with `check_parking_sources.py --gazette`. Islington's
`reviewedNotices` holds the version of its consolidated charged-for parking order last checked. None of this edits
the data. After checking an issue, update `parking_sources.json` and the built files, and the recorded
`ringgo` date. Add new MyRingGo codes with a `null` date and run the script with
`--write --only ringgo` to record their current dates without opening issues.

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
