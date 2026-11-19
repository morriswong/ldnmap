#!/usr/bin/env python3
"""Client for the Department for Transport's D-TRO service (digital traffic regulation orders).
No dependencies.

Councils publish their traffic orders to D-TRO as structured data (zones, hours, max stays,
charges), the same orders they announce in the London Gazette. Reading it needs a free consumer
application from the D-TRO portal (https://dtro-ui.dft.gov.uk): its client ID and secret go in
DTRO_CLIENT_ID and DTRO_CLIENT_SECRET. DTRO_BASE picks the environment (default production;
integration is https://dtro-integration.dft.gov.uk/v1).

Councils are identified by their GeoPlace SWA code (`swaCode` per borough in parking_sources.json).

Usage (all read-only):
  python3 tools/dtro.py coverage            how many orders each London borough has in D-TRO
  python3 tools/dtro.py events [--days 8]   parking orders published or changed recently
  python3 tools/dtro.py show <D-TRO id>     one order as JSON

API docs: https://pa-digital.github.io/dft-dtro-api-docs/api-documentation/_static/redoc.html
"""
import base64
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SOURCES = os.path.join(ROOT, 'tools', 'parking_sources.json')
BASE = os.environ.get('DTRO_BASE', 'https://dtro.dft.gov.uk/v1').rstrip('/')
UA = 'ldnmap-parking-check/1.0 (+https://ldnmap.pages.dev)'
PAGE_SIZE = 50   # the API's maximum
MAX_PAGES = 200
MIN_INTERVAL = 0.6   # seconds between requests: the API's spike arrest allows 120 a minute
RETRIES = 4          # tries again after HTTP 429, backing off

# D-TRO regulation types that can change where, when or how long you can park, or what it costs.
PARKING_TYPES = {
    'kerbsideControlledParkingZone', 'kerbsideRestrictedParkingZone', 'kerbsidePaymentParkingPlace',
    'kerbsidePermitParkingArea', 'kerbsidePermitParkingPlace', 'kerbsideParkingPlace', 'kerbsideLimitedWaiting',
}
# Types that create or change a whole zone rather than individual bays.
ZONE_TYPES = {'kerbsideControlledParkingZone', 'kerbsideRestrictedParkingZone', 'kerbsidePermitParkingArea'}
# Order stages for temporary orders (works, events): not a lasting change to a zone.
TEMPORARY = re.compile(r'^(ttro|specialEvent)', re.I)


class DtroError(Exception):
    pass


class Client:
    def __init__(self, client_id, client_secret, base=BASE):
        self.base = base
        self._auth = base64.b64encode(f'{client_id}:{client_secret}'.encode()).decode()
        self._token = None
        self._last = 0.0

    @classmethod
    def from_env(cls):
        """A client from DTRO_CLIENT_ID/DTRO_CLIENT_SECRET, or None when they aren't set."""
        cid, secret = os.environ.get('DTRO_CLIENT_ID'), os.environ.get('DTRO_CLIENT_SECRET')
        return cls(cid, secret) if cid and secret else None

    def _request(self, method, path, body=None, form=None, auth=None):
        for attempt in range(RETRIES + 1):
            wait = self._last + MIN_INTERVAL - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            status, data = self._send(method, path, body, form, auth)
            if status != 429 or attempt == RETRIES:
                return status, data
            time.sleep(5 * 2 ** attempt)

    def _send(self, method, path, body, form, auth):
        headers = {'User-Agent': UA, 'Accept': 'application/json'}
        data = None
        if form is not None:
            data = urllib.parse.urlencode(form).encode()
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        elif body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        headers['Authorization'] = auth or f'Bearer {self.token()}'
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw.strip() else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                payload = json.loads(raw) if raw.strip() else None
            except ValueError:
                payload = raw[:300].decode('utf-8', 'replace')
            return e.code, payload
        except (urllib.error.URLError, TimeoutError) as e:
            raise DtroError(f'{method} {path}: {e}') from e

    def token(self):
        if not self._token:
            status, data = self._request('POST', '/oauth-generator', form={'grant_type': 'client_credentials'},
                                         auth=f'Basic {self._auth}')
            if status != 200 or not isinstance(data, dict) or not data.get('access_token'):
                raise DtroError(f'token request failed (HTTP {status}): check DTRO_CLIENT_ID/SECRET and that '
                                f'the application is for this environment ({self.base})')
            self._token = data['access_token']
        return self._token

    def post(self, path, body):
        status, data = self._request('POST', path, body=body)
        if status == 404:      # /events answers 404 when nothing matches
            return None
        if status != 200:
            raise DtroError(f'POST {path} failed (HTTP {status}): {data}')
        return data

    def get(self, path):
        status, data = self._request('GET', path)
        if status != 200:
            raise DtroError(f'GET {path} failed (HTTP {status}): {data}')
        return data

    def events(self, since, to, **filters):
        """Every event (create/update/delete) for D-TROs created in [since, to], plus `filters`
        (e.g. modifiedFrom/modifiedTo, traCreator). Pages are D-TROs, each expanding to its events."""
        page = 1
        while page <= MAX_PAGES:
            data = self.post('/events', dict(filters, since=iso(since), to=iso(to), page=page, pageSize=PAGE_SIZE))
            batch = (data or {}).get('events') or []
            if not batch:
                return
            yield from batch
            page += 1

    def count(self, **query):
        """How many D-TROs match one search query (e.g. traCreator=5390)."""
        data = self.post('/search', {'queries': [query], 'page': 1, 'pageSize': 1})
        return (data or {}).get('totalCount', 0)


def iso(t):
    # UTC, marked with Z: /events answers HTTP 500 for an unmarked modifiedFrom/modifiedTo
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def london_codes(src):
    """{SWA code: borough id} for boroughs with a swaCode."""
    return {b['swaCode']: bid for bid, b in src['boroughs'].items() if b.get('swaCode')}


def is_parking_change(event):
    """True for a lasting change to parking places or zones (not a temporary order or a deletion)."""
    if event.get('eventType') == 'delete':
        return False
    if not set(event.get('regulationType') or []) & PARKING_TYPES:
        return False
    stages = event.get('orderReportingPoint') or []
    return not stages or not all(TEMPORARY.match(s) for s in stages)


def recent_parking_events(client, src, days, now=None):
    """[(borough id, event)] for London parking orders created or modified in the last `days`,
    one per D-TRO (its latest event)."""
    now = now or dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    since = now - dt.timedelta(days=days)
    codes = london_codes(src)
    latest = {}
    queries = [
        dict(since=since, to=now),                                                  # created
        dict(since=dt.datetime(2000, 1, 1), to=now, modifiedFrom=iso(since), modifiedTo=iso(now)),  # changed
    ]
    for q in queries:
        for e in client.events(**q):
            bid = codes.get(e.get('traCreator')) or codes.get(e.get('currentTraOwner'))
            if not bid or not is_parking_change(e):
                continue
            prev = latest.get(e['id'])
            if not prev or (e.get('eventTime') or '') > (prev[1].get('eventTime') or ''):
                latest[e['id']] = (bid, e)
    return sorted(latest.values(), key=lambda x: (x[0], x[1].get('eventTime') or ''))


def is_zone_wide(event):
    return bool(set(event.get('regulationType') or []) & ZONE_TYPES)


def summary_line(event):
    """One markdown line for an event: name, stage, kinds of parking it touches, id."""
    types = sorted(set(event.get('regulationType') or []) & PARKING_TYPES)
    short = ', '.join(t.replace('kerbside', '') for t in types)
    stage = ', '.join(event.get('orderReportingPoint') or [])
    when = (event.get('eventTime') or '')[:10]
    return (f'{event.get("troName") or "(no name)"}: {event.get("eventType") or "?"} {when}'
            f'{f", {stage}" if stage else ""}; {short} (`{event["id"]}`)')


def describe(event):
    """Markdown lines describing one event, for an issue body."""
    def j(k):
        v = event.get(k) or []
        return ', '.join(v) if isinstance(v, list) else str(v)
    lines = [f'- **Order:** {event.get("troName") or "(no name)"}',
             f'- **Change:** {event.get("eventType") or "?"} at {event.get("eventTime") or event.get("publicationTime") or "?"}',
             f'- **Regulation types:** {j("regulationType")}']
    if event.get('orderReportingPoint'):
        lines.append(f'- **Order stage:** {j("orderReportingPoint")}')
    if event.get('regulationStart'):
        lines.append(f'- **Starts:** {j("regulationStart")}')
    if event.get('regulationEnd'):
        lines.append(f'- **Ends:** {j("regulationEnd")}')
    lines.append(f'- **D-TRO id:** `{event["id"]}` (full order: `python3 tools/dtro.py show {event["id"]}`)')
    return '\n'.join(lines)


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('coverage')
    ev = sub.add_parser('events')
    ev.add_argument('--days', type=int, default=8)
    sh = sub.add_parser('show')
    sh.add_argument('id')
    args = ap.parse_args(argv)
    client = Client.from_env()
    if not client:
        sys.exit('Set DTRO_CLIENT_ID and DTRO_CLIENT_SECRET (a consumer application from https://dtro-ui.dft.gov.uk).')
    src = json.load(open(SOURCES))
    if args.cmd == 'show':
        print(json.dumps(client.get(f'/dtros/{args.id}'), indent=1))
    elif args.cmd == 'coverage':
        total = 0
        for code, bid in sorted(london_codes(src).items(), key=lambda x: x[1]):
            n = client.count(traCreator=code)
            total += n
            print(f'{src["boroughs"][bid]["name"]:24} {code}  {n}')
        print(f'London boroughs: {total} D-TROs')
    else:
        found = recent_parking_events(client, src, args.days)
        for bid, e in found:
            print(f'== {src["boroughs"][bid]["name"]}\n{describe(e)}\n')
        print(f'{len(found)} parking orders in the last {args.days} days')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except DtroError as e:
        sys.exit(f'D-TRO: {e}')
