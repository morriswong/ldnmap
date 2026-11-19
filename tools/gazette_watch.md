# Checking the Gazette by hand

Councils publish traffic orders (new controlled hours, days, max stays, charges) in the London
Gazette, usually weeks before they take effect. The weekly watch reads the same orders from the
DfT's D-TRO service (`tools/dtro.py`), but not every borough publishes there yet: the watch log
lists which do. The Gazette refuses scripted requests from GitHub's runners and from the server, so
for the others check it in a browser with these steps.

1. Fetch each search, sorted newest first, for the last 8 days (set `start-publish-date` to
   today minus 8 days, `YYYY-MM-DD`), 100 results a page. Read every page.
   - `https://www.thegazette.co.uk/all-notices/notice?text=%22controlled+parking+zone%22&start-publish-date=DATE&sort-by=latest-date&results-page-size=100`
   - `https://www.thegazette.co.uk/all-notices/notice?text=%22controlled+hours%22&start-publish-date=DATE&sort-by=latest-date&results-page-size=100`
   - `https://www.thegazette.co.uk/all-notices/notice?text=%22maximum+stay%22&start-publish-date=DATE&sort-by=latest-date&results-page-size=100`
   - `https://www.thegazette.co.uk/all-notices/notice?text=%22pay+and+display%22&start-publish-date=DATE&sort-by=latest-date&results-page-size=100`
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
