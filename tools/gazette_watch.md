# Checking the Gazette by hand

Councils publish traffic orders (new controlled hours, days, max stays, charges) in the London
Gazette, usually weeks before they take effect. The weekly watch reads the same orders from the
DfT's D-TRO service (`tools/dtro.py`) and, for boroughs not in D-TRO yet, from the councils' own
websites (`tools/council_notices.py`). That leaves the boroughs whose sites refuse scripted requests
(`BLOCKED` in `tools/council_notices.py`: H&F, Camden, Southwark, Barking & Dagenham, Bromley, Harrow,
Havering, Hillingdon). The Gazette refuses scripted requests too, so check it for those in a browser
now and then with these steps.

1. Fetch each search, sorted newest first, for the last 8 days (set `start-publish-date` to
   today minus 8 days, `YYYY-MM-DD`), 100 results a page. Read every page. Fetch the Gazette one
   page at a time, never several at once. Keep `%20` for the spaces in the search text: with `+`
   the site has answered HTTP 400 to some of these searches (seen 2026-11-23).
   - `https://www.thegazette.co.uk/all-notices/notice?text=%22controlled%20parking%20zone%22&start-publish-date=DATE&sort-by=latest-date&results-page-size=100`
   - `https://www.thegazette.co.uk/all-notices/notice?text=%22controlled%20hours%22&start-publish-date=DATE&sort-by=latest-date&results-page-size=100`
   - `https://www.thegazette.co.uk/all-notices/notice?text=%22maximum%20stay%22&start-publish-date=DATE&sort-by=latest-date&results-page-size=100`
   - `https://www.thegazette.co.uk/all-notices/notice?text=%22pay%20and%20display%22&start-publish-date=DATE&sort-by=latest-date&results-page-size=100`
2. Keep only "Road Traffic Acts" notices from a borough in `tools/parking_sources.json`
   (`boroughs`). Open each one (`https://www.thegazette.co.uk/notice/<id>`).
3. File a notice when it changes, or proposes to change, any of these for a controlled parking
   zone or pay-to-park bays: the hours or days, a max stay, or the prices. Skip notices that only
   add or move individual bays, yellow lines at junctions, disabled bays, car club bays, EV bays,
   suspensions for events or works, or speed limits and road closures.
4. For each one to file, run from the repo root:

   ```
   python3 tools/check_parking_sources.py --gazette <id> --borough <borough id> \
     --summary "<proposed or made>; <zones>; <what changes, from what to what>; <date it takes effect, if stated>"
   ```

   It opens a `parking-data` issue and skips a notice that already has one, so a notice seen in two
   weekly runs is filed once. Never edit the parking data from this watch: a person checks the
   notice and the council first.
5. If the Gazette refuses the fetch, or a search shows no results page at all, say so in the run's
   reply. Don't treat that as "nothing changed".
