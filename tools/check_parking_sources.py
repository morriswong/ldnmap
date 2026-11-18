#!/usr/bin/env python3
"""Weekly check for council parking changes the map's data may be missing. No dependencies.

Opens one GitHub issue per finding (label `parking-data`, de-duplicated by title), or prints them
with --dry-run. It never edits the data: a person checks the council and updates
tools/parking_sources.json.

Checks:
  ringgo    For boroughs with a `ringgo` entry in parking_sources.json ({slug, locations: {code: date}}),
            each MyRingGo location page's "Last tariff update". A new date usually means new hours,
            prices or max stay (H&F zone H's changed three weeks before its new hours started).
            A null date is a baseline: it is recorded (with --write) and not reported.
  holidays  rules.json's bank holiday list runs at least 180 days ahead.
  gazette   New London Gazette "Road Traffic Acts" notices from the last 8 days that mention a
            controlled parking zone and hours or a max stay, per borough. If the Gazette refuses
            the request (it blocks some networks), this is reported in the log, not as a failure.

Usage:
  python3 tools/check_parking_sources.py [--dry-run] [--write] [--limit N] [--only ringgo,holidays,gazette]
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
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SOURCES = os.path.join(ROOT, 'tools', 'parking_sources.json')
RULES = os.path.join(ROOT, 'data', 'parking', 'rules.json')
UA = 'ldnmap-parking-check/1.0 (+https://ldnmap.pages.dev)'
RINGGO = 'https://www.myringgo.com/{slug}/parkinglocator/{code}'
GAZETTE = 'https://www.thegazette.co.uk/all-notices/notice'
LABEL = 'parking-data'
RINGGO_DELAY = 5      # seconds between MyRingGo requests: it rate-limits
GAZETTE_DELAY = 2
HOLIDAY_RUNWAY = 180  # days
GAZETTE_DAYS = 8      # a little over a week, so a late weekly run doesn't miss a day
GAZETTE_HINT = re.compile(r'monday|tuesday|wednesday|thursday|friday|saturday|sunday|maximum stay|'
                          r'controlled (hours|times)|extended|operat', re.I)


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


def gazette_name(b):
    return b['name'].replace('&', 'and')


def check_gazette(src, findings, today):
    since = (today - dt.timedelta(days=GAZETTE_DAYS)).isoformat()
    for bid, b in src['boroughs'].items():
        q = urllib.parse.urlencode({'text': f'"controlled parking zone" "{gazette_name(b)}"',
                                    'start-publish-date': since, 'sort-by': 'latest-date'})
        status, raw = get(f'{GAZETTE}?{q}')
        time.sleep(GAZETTE_DELAY)
        if status != 200:
            print(f'  gazette unreachable (HTTP {status}); skipping the Gazette check', file=sys.stderr)
            return
        for nid, chunk in re.findall(r'href="(?:https://www\.thegazette\.co\.uk)?/notice/(\d+)"(.*?)(?=href="(?:https://www\.thegazette\.co\.uk)?/notice/\d+"|$)',
                                     raw, flags=re.S):
            text = page_text(chunk)[:1500]
            if 'Road Traffic' not in text and 'Traffic' not in text:
                continue
            if not GAZETTE_HINT.search(text):
                continue
            findings.append({
                'title': f'Parking: {b["name"]} traffic order, Gazette notice {nid}',
                'body': (f'A new Road Traffic Acts notice for {b["name"]} mentions a controlled parking zone and '
                         f'hours or a max stay: https://www.thegazette.co.uk/notice/{nid}\n\n> {text[:600]}\n\n'
                         'Check whether it\'s a made order (not just a proposal), when it comes into force, and '
                         'update `tools/parking_sources.json` and the built data if it changes zone hours, max '
                         'stays or prices.'),
            })
        print(f'  gazette {bid}: checked', file=sys.stderr)


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
    ap.add_argument('--only', default='ringgo,holidays,gazette')
    args = ap.parse_args()
    only = set(args.only.split(','))
    src = json.load(open(SOURCES))
    today = dt.date.today()
    findings = []
    if 'holidays' in only:
        check_holidays(findings, today)
    if 'ringgo' in only and check_ringgo(src, findings, args.limit, args.write):
        with open(SOURCES, 'w') as f:
            json.dump(src, f, indent=1, ensure_ascii=False)
    if 'gazette' in only:
        check_gazette(src, findings, today)
    for f in findings:
        print(f'FINDING: {f["title"]}')
    if not findings:
        print('No changes found.')
    if findings and not args.dry_run:
        open_issues(findings)


if __name__ == '__main__':
    main()
