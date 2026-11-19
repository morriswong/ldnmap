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

The London Gazette (where councils publish traffic orders) refuses every request from GitHub's
runners and from this project's server, robots.txt included, so no script here reads it. A weekly
Claude run reads it with its web fetch instead (tools/gazette_watch.md) and files each notice
through --gazette, which gives it the same title, label and de-duplication as the checks above.

Usage:
  python3 tools/check_parking_sources.py [--dry-run] [--write] [--limit N] [--only ringgo,holidays]
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
HOLIDAY_RUNWAY = 180  # days


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
    ap.add_argument('--only', default='ringgo,holidays')
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
    for f in findings:
        print(f'FINDING: {f["title"]}')
    if not findings:
        print('No changes found.')
    if findings and not args.dry_run:
        open_issues(findings)


if __name__ == '__main__':
    main()
