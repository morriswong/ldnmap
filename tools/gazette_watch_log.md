# Gazette parking watch log

One entry per weekly run of `tools/gazette_watch.md`, oldest first. Each run appends its entry,
commits it on `dev` and cherry-picks the commit onto `main` (see step 6 there).

## 2026-11-23

Searches (published from 2026-11-15):
- "controlled parking zone": 3
- "controlled hours": 0
- "maximum stay": 2
- "pay and display": 1

Filed: none.

Skipped:
- 5254877 Greenwich, proposed: cycle hangars replacing 2.5-3 m of existing bays at 23 places, plus small bay and line edits; no zone hours, max stay or price change.
- 5255659 Southwark, proposed: Holyrood Street pedestrian and cycle zone; CPZ F permit bays cut for loading bays.
- 5255658 Southwark, proposed: Lavington Street (CPZ C1) swaps 16 m of pay-by-phone for a new 20 m pay bay (Mon-Fri 8am-6.30pm, Sat 9.30am-12.30pm, max 2 hours), plus motorcycle bays and lines. Closest call: a new bay, not a zone change.
- 5255634 Southwark, made, in force 2026-11-23: bay cuts and yellow lines in CPZs C2, DV, G, J, SEB; new EV bays (max 4 hours).
- 5255652 Harrow, made, in force 2026-11-23: disabled bays; free bays on Colbeck Road (max 3 hours Mon-Fri 8am-8pm).
- 5254874 Westminster, made, in force 2026-11-23: Lupus Street cycle works in the A Zone; pay-by-phone bays become a loading bay, car club and EV bays moved.

Fetch failures: "controlled parking zone" and "maximum stay" got HTTP 400 with `+` for spaces (twice); both worked with `%20`, and the step 1 URLs now use `%20`.
