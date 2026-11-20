# data/

Static data the page fetches. The parking layer's files are in `parking/` (see its README).

## ccz.geojson: the Congestion Charge zone

The London Congestion Charge zone as one GeoJSON Feature (a MultiPolygon in WGS84: the zone and
a 2,700 m² strip by Green Park, near Hyde Park Corner, that the source keeps as a separate shape), about 7 KB.

- **Source:** Transport for London, roads open data,
  `https://s3-eu-west-1.amazonaws.com/roads.data.tfl.gov.uk/boundaries/CC_Boundary_20211026_Shape%20Files.zip`
  (listed at <https://roads.data.tfl.gov.uk/>, `boundaries/` folder). Its metadata says the boundary
  was last updated 20 May 2018; the zone hasn't changed since.
- **Licence:** TfL open data terms, which use the Open Government Licence v2.0. Attribution:
  "Powered by TfL Open Data" (shown on the map with the layer). The boundary contains OS data
  © Crown copyright and database rights.
- **Fetched:** 20 November 2026.
- **Built by:** `python3 tools/build_ccz.py` (no dependencies). It reads the shapefile (British
  National Grid), simplifies each ring with Douglas–Peucker at 2 m, and converts to WGS84 with the
  OS's Helmert transform, which is good to a few metres. Checked against TfL's own WGS84 copy of the
  same boundary (`boundaries/ccz.json`, 2019): every vertex within about 2 m.

The zone's rules (hours, prices, the Christmas break) are in `congestion.js`.

## bank-holidays.json

England and Wales bank holidays (`dates`, `YYYY-MM-DD`), used by the Congestion Charge's weekend
hours. Source: <https://www.gov.uk/bank-holidays.json> (Open Government Licence). The same list is
in `parking/rules.json`; `python3 tools/update_bank_holidays.py` refreshes both.
