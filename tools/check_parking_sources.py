#!/usr/bin/env python3
"""Weekly check for council parking changes the map's data may be missing. No dependencies.

Opens one GitHub issue per finding (label `parking-data`, de-duplicated by title; D-TRO orders
come as one weekly digest), or prints them
with --dry-run. It never edits the data: a person checks the council and updates
tools/parking_sources.json.

Checks:
  ringgo    For boroughs with a `ringgo` entry in parking_sources.json ({slug, locations: {code: date}}),
            each MyRingGo location page's "Last tariff update". A new date usually means new hours,
            prices or max stay (H&F zone H's changed three weeks before its new hours started).
            A null date is a baseline: it is recorded (with --write) and not reported.
  holidays  rules.json's bank holiday list runs at least 180 days ahead.
  dtro      Traffic orders London boroughs published to the DfT's D-TRO service in the last 8 days
            that create or change controlled zones, paid or permit parking places or limited
            waiting (tools/dtro.py). Needs DTRO_CLIENT_ID and DTRO_CLIENT_SECRET; skipped without them.
            Also logs how many orders each borough has in D-TRO, to show which ones publish yet.

  councils  For boroughs not in D-TRO yet, parking notices from the councils' own websites in the last
            45 days (tools/council_notices.py; one issue per notice). Sites that refuse scripted requests
            are listed there and skipped; a source that fails or parses nothing opens its own issue.

The London Gazette refuses scripted requests from GitHub's runners and from this project's server,
so no script here reads it. A notice found by hand can still be filed with --gazette, which gives
it the same title, label and de-duplication as the checks above.

Usage:
  python3 tools/check_parking_sources.py [--dry-run] [--write] [--limit N] [--only ringgo,holidays,dtro,councils]
  python3 tools/check_parking_sources.py --gazette NOTICE_ID --borough hf --summary "..." [--dry-run]
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SOURCES = os.path.join(ROOT, 'tools', 'parking_sources.json')
RULES = os.path.join(ROOT, 'data', 'parking', 'rules.json')
UA = 'ldnmap-parking-check/1.0 (+https://ldnmap.pages.dev)'
RINGGO = 'https://www.myringgo.com/{slug}/parkinglocator/{code}'
LABEL = 'parking-data'
RINGGO_DELAY = 5      # seconds between MyRingGo requests: it rate-limits
DTRO_DAYS = 8         # a little over a week, so a late weekly run doesn't miss a day
HOLIDAY_RUNWAY = 180  # days
COUNCIL_DAYS = 45     # council notices this recent are reported (repeats are skipped by issue title)


def get(url):
    """(status, text) for a GET; status 0 on a network error."""
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, ''
    except (urllib.error.URLError, TimeoutError) as e:
        print(f'  network error: {url}: {e}', file=sys.stderr)
        return 0, ''


def page_text(raw):
    raw = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', raw, flags=re.S)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', raw))).strip()


def ringgo_page(raw):
    """(location name, last tariff update) from a MyRingGo location page, or (None, None)."""
    t = page_text(raw)
    m = re.search(r'Last tariff update: (\d{1,2} \w+ \d{4})', t)
    if not m:
        return None, None
    n = re.search(r'([^>]{1,80}?) Location Code: ', t)
    name = n.group(1).split('-->')[-1].strip() if n else None
    if name and '/' in name:
        name = name.split('/')[0].strip()
    return name, m.group(1)


def check_ringgo(src, findings, limit, write):
    budget = limit
    changed_sources = False
    for bid, b in src['boroughs'].items():
        rg = b.get('ringgo')
        if not rg:
            continue
        for code, seen in rg['locations'].items():
            if budget is not None:
                if budget <= 0:
                    return changed_sources
                budget -= 1
            url = RINGGO.format(slug=rg['slug'], code=code)
            status, raw = get(url)
            time.sleep(RINGGO_DELAY)
            name, updated = ringgo_page(raw) if status == 200 else (None, None)
            if not updated:
                print(f'  ringgo {bid} {code}: could not read (HTTP {status}); skipped', file=sys.stderr)
                continue
            print(f'  ringgo {bid} {code} {name}: last tariff update {updated} (recorded: {seen})', file=sys.stderr)
            if seen is None:
                if write:
                    rg['locations'][code] = updated
                    changed_sources = True
                continue
            if updated != seen:
                findings.append({
                    'title': f'Parking: {b["name"]} RingGo {code} ({name}) tariff updated {updated}',
                    'body': (f'MyRingGo location **{code}** ({name}) in {b["name"]} shows "Last tariff update: '
                             f'{updated}" (recorded: {seen}).\n\nThis usually means new hours, prices or a new max '
                             f'stay. Check {url} and the council ({b.get("hoursUrl", "")}), update '
                             f'`tools/parking_sources.json` and the built data, then set the recorded date for '
                             f'{code} in the borough\'s `ringgo.locations` to "{updated}".'),
                })
                if write:
                    rg['locations'][code] = updated
                    changed_sources = True
    return changed_sources


def check_holidays(findings, today):
    days = json.load(open(RULES)).get('bankHolidays', [])
    last = max(days) if days else None
    if not last or (dt.date.fromisoformat(last) - today).days < HOLIDAY_RUNWAY:
        findings.append({
            'title': f'Parking: bank holiday list ends {last or "(empty)"}',
            'body': ('The parking layer\'s bank holiday list (rules.json `bankHolidays`) runs out within '
                     f'{HOLIDAY_RUNWAY} days. Run `python3 tools/update_bank_holidays.py` and commit '
                     '`data/parking/rules.json` (gov.uk publishes about two years ahead).'),
        })
    print(f'  bank holidays: last {last}', file=sys.stderr)


def gazette_finding(src, notice_id, borough, summary):
    """The issue for one Gazette traffic order notice (found by tools/gazette_watch.md)."""
    if not re.fullmatch(r'\d{5,9}', notice_id):
        sys.exit(f'--gazette takes a numeric notice id, not {notice_id!r}')
    b = src['boroughs'].get(borough)
    if not b:
        sys.exit(f'unknown borough {borough!r}; use one of: {", ".join(src["boroughs"])}')
    url = f'https://www.thegazette.co.uk/notice/{notice_id}'
    return {
        'title': f'Parking: {b["name"]} traffic order, Gazette notice {notice_id}',
        'body': (f'A London Gazette Road Traffic Acts notice from {b["name"]} may change parking hours, days, '
                 f'max stays or prices: {url}\n\n> {summary.strip()[:1500]}\n\n'
                 'Check whether it is a made order (not just a proposal) and when it comes into force, then '
                 'update `tools/parking_sources.json` and the built data. Found by the weekly Gazette watch '
                 '(`tools/gazette_watch.md`).'),
    }


def check_dtro(src, findings):
    """Recent London parking orders in D-TRO. Returns False if the check could not run."""
    import dtro
    client = dtro.Client.from_env()
    if not client:
        print('  dtro: DTRO_CLIENT_ID/DTRO_CLIENT_SECRET not set; skipping', file=sys.stderr)
        return True
    try:
        publishing = []
        for code, bid in sorted(dtro.london_codes(src).items()):
            n = client.count(traCreator=code)
            if n:
                publishing.append(f'{src["boroughs"][bid]["short"]} {n}')
        print(f'  dtro: orders held per borough: {", ".join(publishing) or "none yet"}', file=sys.stderr)
        found = dtro.recent_parking_events(client, src, DTRO_DAYS)
    except dtro.DtroError as e:
        print(f'  dtro: {e}', file=sys.stderr)
        return False
    if found:
        findings.append(dtro_digest(src, found, dt.date.today()))
    print(f'  dtro: {len(found)} parking orders in the last {DTRO_DAYS} days', file=sys.stderr)
    return True


def check_councils(src, findings, today):
    """Parking notices on the councils' own sites, for boroughs not in D-TRO yet (tools/council_notices.py).
    A notice id listed in a borough's `reviewedNotices` is skipped (used for Islington's consolidated
    order, whose id is its current version)."""
    import council_notices as cn
    found, failures = cn.collect()
    since = today - dt.timedelta(days=COUNCIL_DAYS)
    new = 0
    for n in found:
        b = src['boroughs'][n['borough']]
        if not cn.is_parking(n) or n['id'] in b.get('reviewedNotices', []):
            continue
        if n['date'] and n['date'] < since:
            continue
        new += 1
        findings.append({
            'title': f'Parking: {b["name"]} notice: {n["title"][:110]} ({n["id"]})',
            'body': (f'{b["name"]} lists this on its own website ({n["date"] or "currently listed, undated"}):\n\n'
                     f'> {n["title"]}\n\n{n["url"]}\n\nCheck whether it changes zone hours, days, max stays or '
                     'prices and when it takes effect, then update `tools/parking_sources.json` and the built data. '
                     'Found by the weekly parking watch (`tools/council_notices.py`, check `councils`).'
                     + ('\n\nThis is the consolidated order, so this notice means it was amended. Once checked, '
                        f'replace the old `charged-pps-...` id in Islington\'s `reviewedNotices` with `{n["id"]}`.'
                        if n['kind'] == 'consolidation' else '')),
        })
    for bid, reason in failures:
        findings.append({
            'title': f'Parking watch: {src["boroughs"][bid]["name"]} notice source failing',
            'body': (f'`tools/council_notices.py` could not read {src["boroughs"][bid]["name"]}\'s notices: {reason}.\n\n'
                     'The site may be down for a while, or its layout changed and the parser needs updating.'),
        })
    for bid, reason in cn.BLOCKED.items():
        print(f'  councils: no source for {bid}: {reason}', file=sys.stderr)
    print(f'  councils: {new} parking notices in the last {COUNCIL_DAYS} days, {len(failures)} sources failing',
          file=sys.stderr)


def dtro_digest(src, found, today):
    """One issue for a week's D-TRO parking orders, grouped by borough: London councils publish dozens
    of small bay amendments a week, so one issue per order would bury the few that change a zone."""
    import dtro
    by_borough = {}
    for bid, e in found:
        by_borough.setdefault(bid, []).append(e)
    names = {bid: src['boroughs'][bid]['name'] for bid in by_borough}
    order = sorted(by_borough, key=lambda bid: names[bid])
    zone_wide = [(bid, e) for bid in order for e in by_borough[bid] if dtro.is_zone_wide(e)]
    parts = [f'London boroughs published or changed {len(found)} traffic orders in the DfT\'s D-TRO service '
             f'in the {DTRO_DAYS} days to {today:%Y-%m-%d} that touch parking zones or bays. Check the ones '
             'that change zone hours, days, max stays or prices, and when they take effect, then update '
             '`tools/parking_sources.json` and the built data.',
             '',
             'By borough: ' + ', '.join(f'{names[bid]} {len(by_borough[bid])}' for bid in order)]
    if zone_wide:
        parts += ['', f'## Zone-wide orders ({len(zone_wide)})', 'These create or change a controlled or '
                  'restricted parking zone or a permit area, so they are the likeliest to change the map.']
        for bid, e in zone_wide:
            parts += ['', f'### {names[bid]}', dtro.describe(e)]
    parts += ['', '## All orders']
    for bid in order:
        parts += ['', f'**{names[bid]}**']
        parts += [f'- {dtro.summary_line(e)}' for e in by_borough[bid]]
    parts += ['', 'Full order: `python3 tools/dtro.py show <D-TRO id>`. Found by the weekly parking watch '
              '(`tools/check_parking_sources.py`, check `dtro`).']
    body = '\n'.join(parts)
    if len(body) > 60000:   # GitHub's issue body limit is 65,536
        body = body[:60000] + '\n\n(cut short; run `python3 tools/dtro.py events` for the rest)'
    return {'title': f'Parking: D-TRO orders, week to {today:%Y-%m-%d} ({len(found)})', 'body': body}


def open_issues(findings):
    subprocess.run(['gh', 'label', 'create', LABEL, '--color', 'e74c3c',
                    '--description', 'Council parking changes to check'], capture_output=True)
    existing = subprocess.run(['gh', 'issue', 'list', '--label', LABEL, '--state', 'all', '--limit', '500',
                               '--json', 'title', '-q', '.[].title'], capture_output=True, text=True, check=True)
    titles = set(existing.stdout.splitlines())
    for f in findings:
        if f['title'] in titles:
            print(f'  already open or done: {f["title"]}', file=sys.stderr)
            continue
        subprocess.run(['gh', 'issue', 'create', '--title', f['title'], '--body', f['body'], '--label', LABEL],
                       check=True)
        titles.add(f['title'])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--dry-run', action='store_true', help='print findings, open no issues')
    ap.add_argument('--write', action='store_true', help='record new RingGo dates in parking_sources.json')
    ap.add_argument('--limit', type=int, help='check at most N RingGo locations')
    ap.add_argument('--only', default='ringgo,holidays,dtro,councils')
    ap.add_argument('--gazette', metavar='NOTICE_ID', help='file one Gazette notice (with --borough, --summary)')
    ap.add_argument('--borough', help='borough id from parking_sources.json, for --gazette')
    ap.add_argument('--summary', default='', help='what the notice changes, for --gazette')
    args = ap.parse_args()
    only = set(args.only.split(','))
    src = json.load(open(SOURCES))
    today = dt.date.today()
    findings = []
    if args.gazette:
        findings.append(gazette_finding(src, args.gazette, args.borough, args.summary))
        only = set()
    if 'holidays' in only:
        check_holidays(findings, today)
    if 'ringgo' in only and check_ringgo(src, findings, args.limit, args.write):
        with open(SOURCES, 'w') as f:
            json.dump(src, f, indent=1, ensure_ascii=False)
    ok = check_dtro(src, findings) if 'dtro' in only else True
    if 'councils' in only:
        check_councils(src, findings, today)
    for f in findings:
        print(f'FINDING: {f["title"]}')
    if not findings:
        print('No changes found.')
    if findings and not args.dry_run:
        open_issues(findings)
    if not ok:
        sys.exit('A check could not run; see the log above.')


if __name__ == '__main__':
    main()
